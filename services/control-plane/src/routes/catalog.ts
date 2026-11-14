import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { generateApiKey, SCOPES, sha256 } from "../apiKeys.js";
import { hashPassword } from "../auth.js";
import { withTenant } from "../db.js";
import { notFound, Problem } from "../problem.js";
import * as t from "../schema.js";
import { IdParams, iso } from "./shared.js";

const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export async function catalogRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;
  const viewer = { onRequest: [app.authenticate] };
  const admin = { onRequest: [app.authenticate, app.requireRole("admin")] };
  const owner = { onRequest: [app.authenticate, app.requireRole("owner")] };

  // ---------------------------------------------------------------- tenant and plans
  api.get("/tenant", { ...viewer }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) => {
      const [row] = await drizzle(tx)
        .select({ tenant: t.tenants, plan: t.plans })
        .from(t.tenants)
        .innerJoin(t.plans, eq(t.plans.id, t.tenants.planId));
      if (!row) throw notFound("Tenant");
      return { ...row.tenant, createdAt: iso(row.tenant.createdAt), plan: row.plan };
    }),
  );

  api.patch(
    "/tenant",
    { ...owner, schema: { body: z.object({ name: z.string().trim().min(1).max(200) }) } },
    async (request) =>
      withTenant(db, request.principal.tenantId, async (tx) => {
        await drizzle(tx).update(t.tenants).set({ name: request.body.name });
        return { name: request.body.name };
      }),
  );

  api.get("/plans", { ...viewer }, async (request) =>
    withTenant(db, request.principal.tenantId, (tx) =>
      drizzle(tx).select().from(t.plans).orderBy(asc(t.plans.priceCents)),
    ),
  );

  // ---------------------------------------------------------------- users
  api.get("/users", { ...admin }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) =>
      (await drizzle(tx).select().from(t.users).orderBy(asc(t.users.createdAt))).map((u) => ({
        ...u,
        createdAt: iso(u.createdAt),
      })),
    ),
  );

  api.post(
    "/users",
    {
      ...owner,
      schema: {
        body: z.object({
          email: z.string().trim().toLowerCase().email().max(254),
          password: z.string().min(12).max(200),
          role: z.enum(["admin", "viewer"]),
        }),
      },
    },
    async (request, reply) => {
      const { email, password, role } = request.body;
      const passwordHash = await hashPassword(password);
      try {
        const row = await withTenant(db, request.principal.tenantId, async (tx) => {
          const r = await tx.query(
            "INSERT INTO control.users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id",
            [request.principal.tenantId, email, passwordHash, role],
          );
          return r.rows[0] as { id: string };
        });
        return reply.status(201).send({ id: row.id, email, role });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new Problem(409, "email-taken", "That email is already registered");
        throw e;
      }
    },
  );

  api.delete("/users/:id", { ...owner, schema: { params: IdParams } }, async (request, reply) => {
    if (request.params.id === request.principal.userId) {
      throw new Problem(409, "cannot-remove-self", "An owner cannot remove themselves");
    }
    const removed = await withTenant(db, request.principal.tenantId, async (tx) =>
      drizzle(tx).delete(t.users).where(eq(t.users.id, request.params.id)).returning({ id: t.users.id }),
    );
    if (removed.length === 0) throw notFound("User");
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- API keys
  api.get("/api-keys", { ...owner }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) =>
      (await drizzle(tx).select().from(t.apiKeys).orderBy(asc(t.apiKeys.createdAt))).map((k) => ({
        ...k,
        createdAt: iso(k.createdAt),
        revokedAt: iso(k.revokedAt),
        lastUsedAt: iso(k.lastUsedAt),
      })),
    ),
  );

  api.post(
    "/api-keys",
    {
      ...owner,
      schema: {
        body: z.object({
          name: z.string().trim().max(200).default(""),
          scopes: z
            .array(z.enum(SCOPES))
            .min(1)
            .default([...SCOPES]),
        }),
      },
    },
    async (request, reply) => {
      const { key, prefix } = generateApiKey();
      const row = await withTenant(db, request.principal.tenantId, async (tx) => {
        const r = await tx.query(
          "INSERT INTO control.api_keys (tenant_id, prefix, key_hash, name, scopes) VALUES ($1, $2, $3, $4, $5) RETURNING id",
          [request.principal.tenantId, prefix, sha256(key), request.body.name, request.body.scopes],
        );
        return r.rows[0] as { id: string };
      });
      // The key is shown once; only its hash is stored.
      return reply
        .status(201)
        .send({ id: row.id, key, prefix, name: request.body.name, scopes: request.body.scopes });
    },
  );

  api.delete("/api-keys/:id", { ...owner, schema: { params: IdParams } }, async (request, reply) => {
    const revoked = await withTenant(db, request.principal.tenantId, (tx) =>
      drizzle(tx)
        .update(t.apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(t.apiKeys.id, request.params.id), isNull(t.apiKeys.revokedAt)))
        .returning({ id: t.apiKeys.id }),
    );
    if (revoked.length === 0) throw notFound("API key");
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- event types and subscriptions
  api.get("/event-types", { ...viewer }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) =>
      (await drizzle(tx).select().from(t.eventTypes).orderBy(asc(t.eventTypes.name))).map((e) => ({
        ...e,
        createdAt: iso(e.createdAt),
      })),
    ),
  );

  api.post(
    "/event-types",
    { ...admin, schema: { body: z.object({ name: z.string().regex(EVENT_TYPE) }) } },
    async (request, reply) => {
      try {
        const [row] = await withTenant(db, request.principal.tenantId, (tx) =>
          drizzle(tx)
            .insert(t.eventTypes)
            .values({ tenantId: request.principal.tenantId, name: request.body.name })
            .returning(),
        );
        return reply.status(201).send({ ...row, createdAt: iso(row?.createdAt) });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new Problem(409, "exists", "That event type already exists");
        throw e;
      }
    },
  );

  api.get("/subscriptions", { ...viewer }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) =>
      (
        await drizzle(tx)
          .select({ sub: t.subscriptions, eventType: t.eventTypes.name })
          .from(t.subscriptions)
          .innerJoin(t.eventTypes, eq(t.eventTypes.id, t.subscriptions.eventTypeId))
          .orderBy(asc(t.subscriptions.createdAt))
      ).map((r) => ({ ...r.sub, eventType: r.eventType, createdAt: iso(r.sub.createdAt) })),
    ),
  );

  api.post(
    "/subscriptions",
    {
      ...admin,
      schema: {
        body: z.object({ endpoint_id: z.string().uuid(), event_type: z.string().regex(EVENT_TYPE) }),
      },
    },
    async (request, reply) => {
      const tenantId = request.principal.tenantId;
      const row = await withTenant(db, tenantId, async (tx) => {
        const d = drizzle(tx);
        // Row-level security limits both lookups to this tenant, so another tenant's
        // endpoint or event type is simply not found.
        const [endpoint] = await d
          .select({ id: t.endpoints.id })
          .from(t.endpoints)
          .where(eq(t.endpoints.id, request.body.endpoint_id));
        if (!endpoint) throw notFound("Endpoint");
        const [type] = await d
          .select({ id: t.eventTypes.id })
          .from(t.eventTypes)
          .where(eq(t.eventTypes.name, request.body.event_type));
        if (!type) throw notFound("Event type");
        try {
          const [sub] = await d
            .insert(t.subscriptions)
            .values({ tenantId, endpointId: endpoint.id, eventTypeId: type.id })
            .returning();
          return sub;
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new Problem(409, "exists", "Already subscribed");
          throw e;
        }
      });
      return reply
        .status(201)
        .send({ ...row, eventType: request.body.event_type, createdAt: iso(row?.createdAt) });
    },
  );

  api.delete("/subscriptions/:id", { ...admin, schema: { params: IdParams } }, async (request, reply) => {
    const removed = await withTenant(db, request.principal.tenantId, (tx) =>
      drizzle(tx)
        .delete(t.subscriptions)
        .where(eq(t.subscriptions.id, request.params.id))
        .returning({ id: t.subscriptions.id }),
    );
    if (removed.length === 0) throw notFound("Subscription");
    return reply.status(204).send();
  });
}
