import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { type Tx, withTenant } from "../db.js";
import { notFound, Problem } from "../problem.js";
import { decodeCursor, encodeCursor, IdParams, iso } from "./shared.js";

const STATUSES = ["scheduled", "queued", "in_flight", "succeeded", "dead", "cancelled"] as const;

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_created_at: Date;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  message_id: string;
  replay_of: string | null;
  last_error_class: string | null;
  created_at: Date;
  updated_at: Date;
}

const view = (d: DeliveryRow) => ({
  id: d.id,
  endpoint_id: d.endpoint_id,
  event_id: d.event_id,
  status: d.status,
  attempt_count: d.attempt_count,
  next_attempt_at: iso(d.next_attempt_at),
  message_id: d.message_id,
  replay_of: d.replay_of,
  last_error_class: d.last_error_class,
  created_at: iso(d.created_at),
  updated_at: iso(d.updated_at),
});

const COLUMNS =
  "d.id, d.endpoint_id, d.event_id, d.event_created_at, d.status, d.attempt_count, d.next_attempt_at, " +
  "d.message_id, d.replay_of, d.last_error_class, d.created_at, d.updated_at";

/** Replay one delivery through the guarded function; maps its errors to HTTP. */
async function replayOne(tx: Tx, id: string, mode: "new" | "reuse" | undefined) {
  await tx.query("SAVEPOINT replay");
  try {
    const r = await tx.query("SELECT * FROM delivery.replay_delivery($1, $2)", [id, mode ?? null]);
    await tx.query("RELEASE SAVEPOINT replay");
    const row = r.rows[0] as { o_delivery_id: string; o_message_id: string; o_mode: string };
    return {
      delivery_id: row.o_delivery_id,
      message_id: row.o_message_id,
      message_id_mode: row.o_mode,
      replay_of: id,
    };
  } catch (e) {
    await tx.query("ROLLBACK TO SAVEPOINT replay");
    const err = e as { code?: string; detail?: string };
    if (err.code === "P0002") throw notFound("Delivery");
    if (err.code === "55000")
      throw new Problem(409, "delivery-active", "Only finished deliveries can be replayed");
    if (err.code === "RL410") {
      throw new Problem(410, "replay-unavailable", "The payload has expired", undefined, {
        reason: "payload_expired",
        expired_at: err.detail || null,
      });
    }
    throw e;
  }
}

export async function deliveryRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.deps;
  const viewer = { onRequest: [app.authenticate] };
  const admin = { onRequest: [app.authenticate, app.requireRole("admin")] };

  api.get(
    "/deliveries",
    {
      ...viewer,
      schema: {
        querystring: z.object({
          endpoint_id: z.string().uuid().optional(),
          status: z.enum(STATUSES).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (request) => {
      const q = request.query;
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        args.push(value);
        where.push(sql.replace("?", `$${args.length}`));
      };
      if (q.endpoint_id) add("d.endpoint_id = ?", q.endpoint_id);
      if (q.status) add("d.status = ?", q.status);
      if (q.from) add("d.created_at >= ?", q.from);
      if (q.to) add("d.created_at < ?", q.to);
      const cursor = decodeCursor(q.cursor);
      if (q.cursor && !cursor) throw new Problem(422, "invalid-cursor", "Invalid cursor");
      if (cursor) {
        args.push(cursor[0], cursor[1]);
        where.push(`(d.created_at, d.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
      }
      args.push(q.limit + 1);
      const sql =
        `SELECT ${COLUMNS}, d.created_at::text AS cursor_ts FROM delivery.deliveries d ` +
        `${where.length ? `WHERE ${where.join(" AND ")}` : ""} ` +
        `ORDER BY d.created_at DESC, d.id DESC LIMIT $${args.length}`;
      return withTenant(db, request.principal.tenantId, async (tx) => {
        const rows = (await tx.query(sql, args)).rows as (DeliveryRow & { cursor_ts: string })[];
        const page = rows.slice(0, q.limit);
        const last = page[page.length - 1];
        return {
          data: page.map(view),
          next_cursor: rows.length > q.limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
        };
      });
    },
  );

  api.get("/deliveries/:id", { ...viewer, schema: { params: IdParams } }, async (request) =>
    withTenant(db, request.principal.tenantId, async (tx) => {
      const r = await tx.query(`SELECT ${COLUMNS} FROM delivery.deliveries d WHERE d.id = $1`, [
        request.params.id,
      ]);
      const d = r.rows[0] as DeliveryRow | undefined;
      if (!d) throw notFound("Delivery");
      const attempts = await tx.query(
        "SELECT attempt_no, counted, outcome, status_code, error_class, created_at FROM delivery.delivery_attempts " +
          "WHERE delivery_id = $1 ORDER BY id",
        [d.id],
      );
      // AC-3: the payload is readable only inside the tenant's retention window.
      const ev = await tx.query(
        "SELECT e.event_type, e.payload, e.created_at + make_interval(days => t.retention_days) AS expires_at, " +
          "e.created_at + make_interval(days => t.retention_days) > now() AS visible " +
          "FROM delivery.deliveries d JOIN delivery.events e ON e.id = d.event_id AND e.created_at = d.event_created_at " +
          "JOIN control.tenants t ON t.id = e.tenant_id WHERE d.id = $1",
        [d.id],
      );
      const event = ev.rows[0] as
        | { event_type: string; payload: unknown; expires_at: Date; visible: boolean }
        | undefined;
      return {
        ...view(d),
        event: event
          ? {
              id: d.event_id,
              event_type: event.event_type,
              payload: event.visible ? event.payload : null,
              payload_expires_at: iso(event.expires_at),
              payload_expired: !event.visible,
            }
          : { id: d.event_id, payload: null, payload_expired: true },
        attempts: attempts.rows.map((a) => ({ ...a, created_at: iso(a.created_at) })),
      };
    }),
  );

  api.post(
    "/deliveries/:id/replay",
    {
      ...admin,
      schema: {
        params: IdParams,
        body: z.object({ message_id: z.enum(["new", "reuse"]).optional() }).default({}),
      },
    },
    async (request, reply) => {
      const result = await withTenant(db, request.principal.tenantId, (tx) =>
        replayOne(tx, request.params.id, request.body.message_id),
      );
      return reply.status(202).send(result);
    },
  );

  // Bulk replay: dry_run (the default) reports what would happen before anything is sent.
  api.post(
    "/replays",
    {
      ...admin,
      schema: {
        body: z.object({
          endpoint_id: z.string().uuid().optional(),
          status: z.enum(["dead", "succeeded"]).default("dead"),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          message_id: z.enum(["new", "reuse"]).optional(),
          dry_run: z.boolean().default(true),
          limit: z.number().int().min(1).max(1000).default(1000),
        }),
      },
    },
    async (request) => {
      const b = request.body;
      return withTenant(db, request.principal.tenantId, async (tx) => {
        const args: unknown[] = [];
        const where: string[] = ["d.status IN ('succeeded', 'dead')"];
        if (b.endpoint_id) where.push(`d.endpoint_id = $${args.push(b.endpoint_id)}`);
        if (b.from) where.push(`d.created_at >= $${args.push(b.from)}`);
        if (b.to) where.push(`d.created_at < $${args.push(b.to)}`);
        const rows = (
          await tx.query(
            "SELECT d.id, d.status, e.created_at + make_interval(days => t.retention_days) > now() AS replayable " +
              "FROM delivery.deliveries d " +
              "LEFT JOIN delivery.events e ON e.id = d.event_id AND e.created_at = d.event_created_at " +
              "LEFT JOIN control.tenants t ON t.id = d.tenant_id " +
              `WHERE ${where.join(" AND ")} ORDER BY d.created_at LIMIT $${args.push(b.limit * 4)}`,
            args,
          )
        ).rows as { id: string; status: string; replayable: boolean | null }[];
        const wanted = rows.filter((r) => r.status === b.status);
        const counts = {
          replayable: wanted.filter((r) => r.replayable).length,
          expired: wanted.filter((r) => !r.replayable).length,
          already_succeeded: b.status === "dead" ? rows.filter((r) => r.status === "succeeded").length : 0,
        };
        if (b.dry_run) return { dry_run: true, ...counts, replayed: 0 };
        const targets = wanted.filter((r) => r.replayable).slice(0, b.limit);
        for (const r of targets) await replayOne(tx, r.id, b.message_id);
        return { dry_run: false, ...counts, replayed: targets.length };
      });
    },
  );

  api.get(
    "/usage",
    {
      ...viewer,
      schema: { querystring: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }) },
    },
    async (request) =>
      withTenant(db, request.principal.tenantId, async (tx) => {
        const history = await tx.query(
          "SELECT day::text, events_ingested::int, attempts::int, successes::int FROM control.usage_daily " +
            "WHERE day > current_date - $1::int ORDER BY day",
          [request.query.days],
        );
        const month = await tx.query(
          "SELECT (SELECT count(*)::int FROM delivery.events WHERE created_at >= date_trunc('month', now())) AS events, " +
            "p.events_per_month, p.max_endpoints, p.id AS plan " +
            "FROM control.tenants t JOIN control.plans p ON p.id = t.plan_id",
        );
        const m = month.rows[0] as {
          events: number;
          events_per_month: number;
          max_endpoints: number;
          plan: string;
        };
        return {
          plan: m.plan,
          month_to_date: {
            events: m.events,
            limit: m.events_per_month,
            share: m.events / m.events_per_month,
          },
          daily: history.rows,
        };
      }),
  );
}
