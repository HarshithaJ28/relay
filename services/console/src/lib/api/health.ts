"use client";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import type { LiveEvent } from "../live/stream";
import { unwrap } from "./client";

export const Health = z.object({
  endpoint_id: z.string(),
  window_hours: z.number().int(),
  attempts: z.number().int(),
  successes: z.number().int(),
  success_rate: z.number().nullable(),
  errors_by_class: z.record(z.string(), z.number().int()),
  active_deliveries: z.number().int(),
  breaker: z.union([
    z.object({ state: z.literal("closed") }),
    z.object({ state: z.literal("open"), until: z.string().nullable() }),
  ]),
});
export type Health = z.infer<typeof Health>;

export type BreakerView =
  | { state: "closed" }
  | { state: "open"; until: string }
  | { state: "probing"; since: string | null };

/**
 * The breaker as the console shows it. The API says "open" until a successful probe closes
 * it; once `until` has passed the endpoint is half-open: the scheduler sends one probe
 * delivery and a success closes the breaker (migration 0009). There is no live event for the
 * close, so a delivery event for the endpoint triggers a refetch.
 */
export function breakerState(breaker: Health["breaker"], now: number = Date.now()): BreakerView {
  if (breaker.state === "closed") return { state: "closed" };
  if (breaker.until && Date.parse(breaker.until) > now) return { state: "open", until: breaker.until };
  return { state: "probing", since: breaker.until };
}

/** A breaker event opens (or re-opens) the breaker at once; the refetch that follows fills the rest. */
export function applyBreakerEvent(health: Health | undefined, event: LiveEvent): Health | undefined {
  if (!health || event.type !== "breaker" || event.endpoint_id !== health.endpoint_id) return health;
  return { ...health, breaker: { state: "open", until: event.until } };
}

/** Error classes, most frequent first. */
export function errorRows(
  errors: Record<string, number>,
): Array<{ errorClass: string; count: number; share: number }> {
  const total = Object.values(errors).reduce((a, b) => a + b, 0);
  return Object.entries(errors)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([errorClass, count]) => ({ errorClass, count, share: total ? count / total : 0 }));
}

export const healthKey = (id: string) => ["endpoints", id, "health"] as const;

export function useHealth(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: healthKey(id),
    queryFn: async () =>
      Health.parse(unwrap(await api.GET("/api/v1/endpoints/{id}/health", { params: { path: { id } } }))),
  });
}
