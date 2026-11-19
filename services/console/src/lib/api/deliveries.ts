"use client";
import { type InfiniteData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import type { LiveEvent } from "../live/stream";
import { unwrap } from "./client";

export const STATUSES = ["scheduled", "queued", "in_flight", "succeeded", "dead", "cancelled"] as const;
export type DeliveryStatus = (typeof STATUSES)[number];

export const Delivery = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  event_id: z.string(),
  status: z.enum(STATUSES),
  attempt_count: z.number().int(),
  next_attempt_at: z.string().nullable(),
  message_id: z.string(),
  replay_of: z.string().nullable(),
  last_error_class: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Delivery = z.infer<typeof Delivery>;

const Page = z.object({ data: z.array(Delivery), next_cursor: z.string().nullable() });
type Page = z.infer<typeof Page>;

export const Attempt = z.object({
  attempt_no: z.number().int(),
  counted: z.boolean(),
  outcome: z.string(),
  status_code: z.number().int().nullable(),
  error_class: z.string().nullable(),
  created_at: z.string(),
});
export type Attempt = z.infer<typeof Attempt>;

export const DeliveryDetail = Delivery.extend({
  event: z.object({
    id: z.string(),
    event_type: z.string().optional(),
    payload: z.unknown().nullable(),
    payload_expires_at: z.string().nullable().optional(),
    payload_expired: z.boolean(),
  }),
  attempts: z.array(Attempt),
});
export type DeliveryDetail = z.infer<typeof DeliveryDetail>;

// ---------------------------------------------------------------- filters (kept in the URL)
export interface Filters {
  endpoint?: string;
  status?: DeliveryStatus;
  from?: string; // ISO time
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTime = (v: string) => !Number.isNaN(Date.parse(v));

/** Read filters from URL search params, dropping anything malformed instead of sending it. */
export function parseFilters(params: URLSearchParams): Filters {
  const f: Filters = {};
  const endpoint = params.get("endpoint");
  const status = params.get("status");
  const from = params.get("from");
  const to = params.get("to");
  if (endpoint && UUID.test(endpoint)) f.endpoint = endpoint;
  if (status && (STATUSES as readonly string[]).includes(status)) f.status = status as DeliveryStatus;
  if (from && isTime(from)) f.from = new Date(from).toISOString();
  if (to && isTime(to)) f.to = new Date(to).toISOString();
  return f;
}

export function filtersToParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.endpoint) p.set("endpoint", f.endpoint);
  if (f.status) p.set("status", f.status);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p;
}

// ---------------------------------------------------------------- live updates
export type LiveAction =
  | { kind: "patch"; pages: InfiniteData<Page> }
  | { kind: "refetch" }
  | { kind: "ignore" };

/**
 * What a delivery event means for the list on screen: a row that is shown is updated in place;
 * a delivery that is not shown but matches the filters means new rows (refetch); anything else
 * is ignored. A delivery is created before its first event, so "now" is inside an open range.
 */
export function applyLiveEvent(
  pages: InfiniteData<Page> | undefined,
  event: LiveEvent,
  filters: Filters,
  now: number = Date.now(),
): LiveAction {
  if (event.type !== "delivery") return { kind: "ignore" };
  if (pages) {
    let found = false;
    const next = {
      ...pages,
      pages: pages.pages.map((page) => ({
        ...page,
        data: page.data.map((d) => {
          if (d.id !== event.delivery_id) return d;
          found = true;
          const status = (STATUSES as readonly string[]).includes(event.status)
            ? (event.status as DeliveryStatus)
            : d.status;
          return {
            ...d,
            status,
            attempt_count: Math.max(d.attempt_count, event.attempt),
            last_error_class: event.error_class,
          };
        }),
      })),
    };
    if (found) return { kind: "patch", pages: next };
  }
  if (filters.endpoint && filters.endpoint !== event.endpoint_id) return { kind: "ignore" };
  if (filters.status && filters.status !== event.status) return { kind: "ignore" };
  if (filters.to && Date.parse(filters.to) <= now) return { kind: "ignore" };
  return { kind: "refetch" };
}

// ---------------------------------------------------------------- queries
export const deliveryKeys = {
  list: (f: Filters) => ["deliveries", "list", f] as const,
  one: (id: string) => ["deliveries", "one", id] as const,
};

export const PAGE_SIZE = 50;

export function useDeliveries(filters: Filters) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: deliveryKeys.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      Page.parse(
        unwrap(
          await api.GET("/api/v1/deliveries", {
            params: {
              query: {
                endpoint_id: filters.endpoint,
                status: filters.status,
                from: filters.from,
                to: filters.to,
                cursor: pageParam,
                limit: PAGE_SIZE,
              },
            },
          }),
        ),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useDelivery(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: deliveryKeys.one(id),
    queryFn: async () =>
      DeliveryDetail.parse(unwrap(await api.GET("/api/v1/deliveries/{id}", { params: { path: { id } } }))),
  });
}
