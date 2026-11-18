import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withTenant } from "../db.js";
import { Problem } from "../problem.js";
import { ProblemSchema } from "./shared.js";

/**
 * GET /api/v1/stats: bucketed counts for the overview charts, from the source tables, for the
 * caller's tenant only (row-level security, and the cache key includes the tenant).
 *
 * - events: events ingested in each bucket;
 * - deliveries: deliveries created in each bucket, by their current status;
 * - attempts: counted send attempts made in each bucket;
 * - success_rate: succeeded / finished, where finished = succeeded + dead + cancelled; null when
 *   nothing has finished.
 *
 * Buckets are UTC hours or days; `from` is rounded down and `to` up to whole buckets, and
 * empty buckets are returned as zeros. Plan and month-to-date usage are not repeated here:
 * they come from GET /api/v1/usage. No latency is returned: attempt durations are not stored.
 */
const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 31;
export const MAX_HOURLY_DAYS = 7;
const STATUSES = ["scheduled", "queued", "in_flight", "succeeded", "dead", "cancelled"] as const;

const Counts = z.object(
  Object.fromEntries(STATUSES.map((s) => [s, z.number().int()])) as Record<
    (typeof STATUSES)[number],
    z.ZodNumber
  >,
);
const Bucket = z.object({
  start: z.string(),
  events: z.number().int(),
  attempts: z.number().int(),
  deliveries: Counts,
  success_rate: z.number().nullable(),
});
const Stats = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(["hour", "day"]),
  generated_at: z.string(),
  totals: Bucket.omit({ start: true }),
  buckets: z.array(Bucket),
});
type StatsBody = z.infer<typeof Stats>;

export function successRate(d: Record<string, number>): number | null {
  const finished = (d.succeeded ?? 0) + (d.dead ?? 0) + (d.cancelled ?? 0);
  return finished === 0 ? null : (d.succeeded ?? 0) / finished;
}

function rangeProblem(detail: string) {
  return new Problem(422, "invalid-range", "Invalid stats range", detail);
}

export async function statsRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { db, statsCache } = app.deps;

  api.get(
    "/stats",
    {
      onRequest: [app.authenticate],
      schema: {
        querystring: z.object({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
          bucket: z.enum(["hour", "day"]).default("day"),
        }),
        response: { 200: Stats, 422: ProblemSchema },
      },
    },
    async (request, reply) => {
      const { bucket } = request.query;
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      const span = to.getTime() - from.getTime();
      if (span <= 0) throw rangeProblem("`to` must be after `from`.");
      if (span > MAX_RANGE_DAYS * DAY_MS)
        throw rangeProblem(`The range can be at most ${MAX_RANGE_DAYS} days.`);
      if (bucket === "hour" && span > MAX_HOURLY_DAYS * DAY_MS) {
        throw rangeProblem(
          `Hourly buckets are available for ranges of up to ${MAX_HOURLY_DAYS} days; use bucket=day.`,
        );
      }
      const tenantId = request.principal.tenantId;
      const key = `${tenantId}:${bucket}:${from.toISOString()}:${to.toISOString()}`;
      if (statsCache) {
        try {
          const hit = await statsCache.get(key);
          if (hit) {
            reply.header("x-relay-cache", "hit");
            return hit as StatsBody;
          }
        } catch (e) {
          request.log.warn({ err: e }, "stats cache unavailable");
        }
      }
      const body = await withTenant(db, tenantId, async (tx) => {
        const r = await tx.query(
          `WITH b AS (
             SELECT gs AS start, gs + $3::interval AS stop
             FROM generate_series(date_trunc($4, $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
                                  $2::timestamptz - interval '1 microsecond', $3::interval) gs
           ),
           e AS (SELECT date_trunc($4, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start, count(*)::int AS n
                 FROM delivery.events WHERE created_at >= (SELECT min(start) FROM b) AND created_at < (SELECT max(stop) FROM b)
                 GROUP BY 1),
           a AS (SELECT date_trunc($4, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start, count(*)::int AS n
                 FROM delivery.delivery_attempts
                 WHERE counted AND created_at >= (SELECT min(start) FROM b) AND created_at < (SELECT max(stop) FROM b)
                 GROUP BY 1),
           d AS (SELECT date_trunc($4, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start, status, count(*)::int AS n
                 FROM delivery.deliveries WHERE created_at >= (SELECT min(start) FROM b) AND created_at < (SELECT max(stop) FROM b)
                 GROUP BY 1, 2)
           SELECT b.start, b.stop, coalesce(e.n, 0) AS events, coalesce(a.n, 0) AS attempts,
                  coalesce((SELECT jsonb_object_agg(status, n) FROM d WHERE d.start = b.start), '{}'::jsonb) AS deliveries
           FROM b LEFT JOIN e ON e.start = b.start LEFT JOIN a ON a.start = b.start
           ORDER BY b.start`,
          [from.toISOString(), to.toISOString(), bucket === "hour" ? "1 hour" : "1 day", bucket],
        );
        const empty = () =>
          Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
        const totals = { events: 0, attempts: 0, deliveries: empty() };
        const buckets = r.rows.map(
          (row: { start: Date; events: number; attempts: number; deliveries: Record<string, number> }) => {
            const deliveries = empty();
            for (const s of STATUSES) {
              deliveries[s] = row.deliveries[s] ?? 0;
              totals.deliveries[s] += deliveries[s];
            }
            totals.events += row.events;
            totals.attempts += row.attempts;
            return {
              start: row.start.toISOString(),
              events: row.events,
              attempts: row.attempts,
              deliveries,
              success_rate: successRate(deliveries),
            };
          },
        );
        const first = r.rows[0] as { start: Date } | undefined;
        const last = r.rows.at(-1) as { stop: Date } | undefined;
        return {
          from: (first?.start ?? from).toISOString(),
          to: (last?.stop ?? to).toISOString(),
          bucket,
          generated_at: new Date().toISOString(),
          totals: { ...totals, success_rate: successRate(totals.deliveries) },
          buckets,
        } satisfies StatsBody;
      });
      if (statsCache) {
        try {
          await statsCache.set(key, body);
        } catch (e) {
          request.log.warn({ err: e }, "stats cache unavailable");
        }
      }
      reply.header("x-relay-cache", statsCache ? "miss" : "off");
      return body;
    },
  );
}
