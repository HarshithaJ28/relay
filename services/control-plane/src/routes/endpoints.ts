import { randomUUID } from "node:crypto";
import { asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { type Tx, withTenant } from "../db.js";
import { notFound, Problem } from "../problem.js";
import * as t from "../schema.js";
import { generateSigningSecret, newEntry, type SecretEntry } from "../secrets.js";
import { BlockedDestination, checkDestination } from "../ssrf.js";
import { IdParams, iso } from "./shared.js";

const TEST_EVENT_TYPE = "relay.test";

function view(e: typeof t.endpoints.$inferSelect) {
  const secrets = (e.signingSecrets as SecretEntry[]).map((s) => ({ kid: s.kid, expires_at: s.expires_at }));
  return {
    id: e.id,
    url: e.url,
    status: e.status,
    concurrency_limit: e.concurrencyLimit,
    breaker_until: iso(e.breakerUntil),
    signing_secrets: secrets, // ids and expiry only; never the secret
    created_at: iso(e.createdAt),
  };
}

export async function endpointRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { db, keyring, resolve, config } = app.deps;
  const viewer = { onRequest: [app.authenticate] };
  const admin = { onRequest: [app.authenticate, app.requireRole("admin")] };

  async function validated(url: string): Promise<string> {
    try {
      await checkDestination(url, config.destination, resolve);
      return url.trim();
    } catch (e) {
      if (e instanceof BlockedDestination)
        throw new Problem(422, "blocked-destination", "Endpoint URL not allowed", e.message);
      throw e;
    }
  }

  async function load(tx: Tx, id: string) {
    const [row] = await drizzle(tx).select().from(t.endpoints).where(eq(t.endpoints.id, id));
    if (!row) throw notFound("Endpoint");
    return row;
  }

  api.get("/endpoints", { ...viewer }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) =>
      (await drizzle(tx).select().from(t.endpoints).orderBy(asc(t.endpoints.createdAt))).map(view),
    ),
  );

  api.post(
    "/endpoints",
    {
      ...admin,
      schema: {
        body: z.object({
          url: z.string().max(2048),
          concurrency_limit: z.number().int().min(1).max(1000).default(10),
        }),
      },
    },
    async (request, reply) => {
      const tenantId = request.principal.tenantId;
      const url = await validated(request.body.url);
      const id = randomUUID();
      const secret = generateSigningSecret();
      const row = await withTenant(db, tenantId, async (tx) => {
        const d = drizzle(tx);
        const [limits] = await d
          .select({ max: t.plans.maxEndpoints })
          .from(t.tenants)
          .innerJoin(t.plans, eq(t.plans.id, t.tenants.planId));
        const [{ n } = { n: 0 }] = await d.select({ n: count() }).from(t.endpoints);
        if (limits && n >= limits.max) {
          throw new Problem(
            409,
            "plan-limit",
            "Endpoint limit reached",
            `this plan allows ${limits.max} endpoints`,
          );
        }
        const [created] = await d
          .insert(t.endpoints)
          .values({
            id,
            tenantId,
            url,
            status: "enabled",
            concurrencyLimit: request.body.concurrency_limit,
            signingSecrets: [newEntry(keyring, id, "s1", secret)],
          })
          .returning();
        return created as typeof t.endpoints.$inferSelect;
      });
      // The signing secret is shown here and by GET /endpoints/{id}/secret; it is stored encrypted.
      return reply.status(201).send({ ...view(row), signing_secret: secret });
    },
  );

  api.get("/endpoints/:id", { ...viewer, schema: { params: IdParams } }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) => view(await load(tx, request.params.id))),
  );

  api.patch(
    "/endpoints/:id",
    {
      ...admin,
      schema: {
        params: IdParams,
        body: z
          .object({
            url: z.string().max(2048).optional(),
            status: z.enum(["enabled", "disabled"]).optional(),
            concurrency_limit: z.number().int().min(1).max(1000).optional(),
          })
          .refine((b) => Object.keys(b).length > 0, "nothing to change"),
      },
    },
    async (request) => {
      const url = request.body.url === undefined ? undefined : await validated(request.body.url);
      return withTenant(db, request.principal.tenantId, async (tx) => {
        const current = await load(tx, request.params.id);
        if (request.body.status && current.status === "breaker_open" && request.body.status === "enabled") {
          throw new Problem(
            409,
            "breaker-open",
            "The circuit breaker is open; it closes after a successful probe",
          );
        }
        const [updated] = await drizzle(tx)
          .update(t.endpoints)
          .set({
            ...(url !== undefined ? { url } : {}),
            ...(request.body.status ? { status: request.body.status } : {}),
            ...(request.body.concurrency_limit ? { concurrencyLimit: request.body.concurrency_limit } : {}),
          })
          .where(eq(t.endpoints.id, request.params.id))
          .returning();
        return view(updated as typeof t.endpoints.$inferSelect);
      });
    },
  );

  // Deleting keeps the delivery history: the endpoint is disabled and unsubscribed.
  api.delete("/endpoints/:id", { ...admin, schema: { params: IdParams } }, async (request, reply) => {
    await withTenant(db, request.principal.tenantId, async (tx) => {
      await load(tx, request.params.id);
      const d = drizzle(tx);
      await d.delete(t.subscriptions).where(eq(t.subscriptions.endpointId, request.params.id));
      await d.update(t.endpoints).set({ status: "disabled" }).where(eq(t.endpoints.id, request.params.id));
    });
    return reply.status(204).send();
  });

  // Rotation: add a new secret and let the old one expire after an overlap, so receivers can
  // switch without downtime (every request carries a signature from each active secret).
  api.post(
    "/endpoints/:id/rotate-secret",
    {
      ...admin,
      schema: {
        params: IdParams,
        body: z
          .object({ overlap_hours: z.number().int().min(0).max(168).default(24) })
          .default({ overlap_hours: 24 }),
      },
    },
    async (request) => {
      const secret = generateSigningSecret();
      return withTenant(db, request.principal.tenantId, async (tx) => {
        const current = await load(tx, request.params.id);
        const now = new Date();
        const live = (current.signingSecrets as SecretEntry[]).filter(
          (s) => s.expires_at === null || new Date(s.expires_at) > now,
        );
        if (live.length >= 2) {
          throw new Problem(
            409,
            "rotation-in-progress",
            "A rotation is already in progress",
            "wait for the old secret to expire",
          );
        }
        const expires = new Date(now.getTime() + request.body.overlap_hours * 3_600_000);
        const kid = `s${Date.now()}`;
        const entries = [
          ...live.map((s) => ({ ...s, expires_at: s.expires_at ?? expires.toISOString() })),
          newEntry(keyring, current.id, kid, secret),
        ];
        const [updated] = await drizzle(tx)
          .update(t.endpoints)
          .set({ signingSecrets: entries })
          .where(eq(t.endpoints.id, current.id))
          .returning();
        return { ...view(updated as typeof t.endpoints.$inferSelect), signing_secret: secret };
      });
    },
  );

  api.get("/endpoints/:id/secret", { ...admin, schema: { params: IdParams } }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) => {
      const e = await load(tx, request.params.id);
      const now = new Date();
      return {
        secrets: (e.signingSecrets as SecretEntry[])
          .filter((s) => s.expires_at === null || new Date(s.expires_at) > now)
          .map((s) => ({ kid: s.kid, expires_at: s.expires_at, secret: keyring.decrypt(e.id, s) })),
      };
    }),
  );

  api.post("/endpoints/:id/test", { ...admin, schema: { params: IdParams } }, async (request, reply) => {
    const tenantId = request.principal.tenantId;
    const result = await withTenant(db, tenantId, async (tx) => {
      const endpoint = await load(tx, request.params.id);
      const payload = {
        type: TEST_EVENT_TYPE,
        message: "Test event from Relay",
        sent_at: new Date().toISOString(),
      };
      // One statement, so the event's created_at reaches the delivery at full precision
      // (a JavaScript Date would round it to milliseconds and break the event join).
      const r = await tx.query(
        "WITH ev AS (INSERT INTO delivery.events (id, tenant_id, event_type, payload, payload_sha256) " +
          "VALUES (gen_random_uuid(), $1, $2, $3::jsonb, sha256(convert_to($4::text, 'UTF8'))) RETURNING id, created_at) " +
          "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at) " +
          "SELECT $1, $5, ev.id, ev.created_at FROM ev RETURNING id, event_id",
        [tenantId, TEST_EVENT_TYPE, JSON.stringify(payload), JSON.stringify(payload), endpoint.id],
      );
      const created = r.rows[0] as { id: string; event_id: string };
      await tx.query("SELECT pg_notify('relay_dispatch', '')");
      return { event_id: created.event_id, delivery_id: created.id };
    });
    return reply.status(202).send(result);
  });

  api.get("/endpoints/:id/health", { ...viewer, schema: { params: IdParams } }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) => {
      const e = await load(tx, request.params.id);
      const r = await tx.query(
        `SELECT count(*) FILTER (WHERE a.counted)::int AS attempts,
                count(*) FILTER (WHERE a.counted AND a.outcome = 'success')::int AS successes,
                coalesce(jsonb_object_agg(a.error_class, a.n) FILTER (WHERE a.error_class IS NOT NULL), '{}') AS errors
         FROM (SELECT x.counted, x.outcome, x.error_class, count(*) OVER (PARTITION BY x.error_class) AS n
               FROM delivery.delivery_attempts x JOIN delivery.deliveries d ON d.id = x.delivery_id
               WHERE d.endpoint_id = $1 AND x.created_at > now() - interval '24 hours') a`,
        [e.id],
      );
      const active = await tx.query(
        "SELECT count(*)::int AS n FROM delivery.deliveries WHERE endpoint_id = $1 AND status IN ('scheduled','queued','in_flight')",
        [e.id],
      );
      const s = r.rows[0] as { attempts: number; successes: number; errors: Record<string, number> };
      return {
        endpoint_id: e.id,
        window_hours: 24,
        attempts: s.attempts,
        successes: s.successes,
        success_rate: s.attempts ? s.successes / s.attempts : null,
        errors_by_class: s.errors,
        active_deliveries: (active.rows[0] as { n: number }).n,
        breaker:
          e.status === "breaker_open" ? { state: "open", until: iso(e.breakerUntil) } : { state: "closed" },
      };
    }),
  );
}
