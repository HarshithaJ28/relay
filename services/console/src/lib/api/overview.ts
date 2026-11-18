"use client";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import { unwrap } from "./client";

const Counts = z.object({
  scheduled: z.number().int(),
  queued: z.number().int(),
  in_flight: z.number().int(),
  succeeded: z.number().int(),
  dead: z.number().int(),
  cancelled: z.number().int(),
});
const Bucket = z.object({
  start: z.string(),
  events: z.number().int(),
  attempts: z.number().int(),
  deliveries: Counts,
  success_rate: z.number().nullable(),
});
export const Stats = z.object({
  from: z.string(),
  to: z.string(),
  bucket: z.enum(["hour", "day"]),
  generated_at: z.string(),
  totals: Bucket.omit({ start: true }),
  buckets: z.array(Bucket),
});
export type Stats = z.infer<typeof Stats>;

export const Usage = z.object({
  plan: z.string(),
  month_to_date: z.object({ events: z.number().int(), limit: z.number().int(), share: z.number() }),
});
export type Usage = z.infer<typeof Usage>;

// ---------------------------------------------------------------- ranges
export const PRESETS = {
  "24h": { label: "Last 24 hours", bucket: "hour", hours: 24 },
  "7d": { label: "Last 7 days", bucket: "day", hours: 7 * 24 },
  "30d": { label: "Last 30 days", bucket: "day", hours: 30 * 24 },
} as const;
export type Preset = keyof typeof PRESETS;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The request for a preset. `to` is the end of the current UTC bucket and `from` a whole
 * number of buckets before it, so every request within a bucket is identical and the
 * server's 30-second cache is used, and every bucket is complete except the current one.
 */
export function rangeFor(preset: Preset, now: number = Date.now()) {
  const { bucket, hours } = PRESETS[preset];
  const size = bucket === "hour" ? HOUR : DAY;
  const to = Math.floor(now / size) * size + size;
  const from = to - hours * HOUR;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucket };
}

// ---------------------------------------------------------------- chart rows
export interface ChartRow {
  start: string;
  label: string;
  events: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  cancelled: number;
  /** Percent, or null when nothing in the bucket has finished. */
  successRate: number | null;
}

const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
// Day buckets are UTC days; label them in UTC so a bucket never shows the wrong date.
const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function chartRows(stats: Stats): ChartRow[] {
  const fmt = stats.bucket === "hour" ? hourLabel : dayLabel;
  return stats.buckets.map((b) => ({
    start: b.start,
    label: fmt.format(new Date(b.start)),
    events: b.events,
    succeeded: b.deliveries.succeeded,
    failed: b.deliveries.dead,
    inProgress: b.deliveries.scheduled + b.deliveries.queued + b.deliveries.in_flight,
    cancelled: b.deliveries.cancelled,
    successRate: b.success_rate === null ? null : Math.round(b.success_rate * 1000) / 10,
  }));
}

export function percent(share: number | null): string {
  return share === null ? "—" : `${(share * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------- queries
export function useStats(preset: Preset) {
  const api = useApi();
  return useQuery({
    queryKey: ["stats", preset],
    // Recomputed each time so a new bucket starts on time; the range only changes at bucket edges.
    queryFn: async () =>
      Stats.parse(unwrap(await api.GET("/api/v1/stats", { params: { query: rangeFor(preset) } }))),
    refetchInterval: 60_000,
  });
}

export function useUsage() {
  const api = useApi();
  return useQuery({
    queryKey: ["usage"],
    queryFn: async () => Usage.parse(unwrap(await api.GET("/api/v1/usage"))),
    refetchInterval: 60_000,
  });
}
