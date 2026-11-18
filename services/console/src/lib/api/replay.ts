"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import { unwrap } from "./client";
import type { DeliveryDetail, DeliveryStatus } from "./deliveries";
import { type Problem, problemSlug } from "./problem";

export type MessageIdMode = "new" | "reuse";

/**
 * The server's default (and ours): a succeeded delivery reached the receiver, so a replay gets
 * a new message id or a deduplicating receiver would drop it. A dead one may or may not have
 * arrived (a timeout or 5xx says nothing), so it reuses the id and deduplication protects the
 * receiver from a double.
 */
export function defaultMode(status: DeliveryStatus): MessageIdMode {
  return status === "succeeded" ? "new" : "reuse";
}

export const REPLAYABLE: readonly DeliveryStatus[] = ["succeeded", "dead", "cancelled"];

/** Why a delivery cannot be replayed right now, or null if it can. */
export function replayBlocked(
  d: Pick<DeliveryDetail, "status" | "event">,
): { reason: "active" } | { reason: "expired"; at: string | null } | null {
  if (!REPLAYABLE.includes(d.status)) return { reason: "active" };
  if (d.event.payload_expired) return { reason: "expired", at: d.event.payload_expires_at ?? null };
  return null;
}

/** The expiry date from a 410 replay-unavailable problem, if that is what this is. */
export function expiredFromProblem(p: Problem): { at: string | null } | null {
  if (p.status !== 410 || problemSlug(p) !== "replay-unavailable") return null;
  return { at: typeof p.expired_at === "string" && p.expired_at ? p.expired_at : null };
}

const ReplayResult = z.object({
  delivery_id: z.string(),
  message_id: z.string(),
  message_id_mode: z.enum(["new", "reuse"]),
  replay_of: z.string(),
});

export const BulkResult = z.object({
  dry_run: z.boolean(),
  replayable: z.number().int(),
  expired: z.number().int(),
  already_succeeded: z.number().int(),
  replayed: z.number().int(),
});
export type BulkResult = z.infer<typeof BulkResult>;

export interface BulkParams {
  endpoint_id?: string;
  status: "dead" | "succeeded";
  from?: string;
  to?: string;
  message_id?: MessageIdMode;
}

/** A stable key for bulk parameters: a preview only counts for exactly these settings. */
export const bulkKey = (p: BulkParams) =>
  JSON.stringify([p.endpoint_id ?? null, p.status, p.from ?? null, p.to ?? null, p.message_id ?? null]);

export function useReplay(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (mode: MessageIdMode) =>
      ReplayResult.parse(
        unwrap(
          await api.POST("/api/v1/deliveries/{id}/replay", {
            params: { path: { id } },
            body: { message_id: mode },
          }),
        ),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deliveries"] }),
  });
}

export function useBulkReplay() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ params, dryRun }: { params: BulkParams; dryRun: boolean }) =>
      BulkResult.parse(unwrap(await api.POST("/api/v1/replays", { body: { ...params, dry_run: dryRun } }))),
    onSuccess: (result) => {
      if (!result.dry_run) void qc.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });
}
