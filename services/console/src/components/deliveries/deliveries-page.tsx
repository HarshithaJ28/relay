"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  applyLiveEvent,
  deliveryKeys,
  type Filters,
  filtersToParams,
  parseFilters,
  STATUSES,
  useDeliveries,
} from "@/lib/api/deliveries";
import { useEndpoints } from "@/lib/api/endpoints";
import { toProblem } from "@/lib/api/problem";
import { formatDate, formatRelative } from "@/lib/format";
import { useLiveEvents } from "@/lib/live/context";
import { DeliveryStatusBadge } from "./status-badge";

/** Debounce for refetching when new deliveries arrive, so a burst costs one request. */
export const REFETCH_DEBOUNCE_MS = 1_000;

// <input type="datetime-local"> works in local time without a zone; the URL keeps ISO UTC.
const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : undefined);

export function DeliveriesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);
  const list = useDeliveries(filters);
  const endpoints = useEndpoints();
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useLiveEvents((event) => {
    const key = deliveryKeys.list(filters);
    const action = applyLiveEvent(qc.getQueryData(key), event, filters);
    if (action.kind === "patch") qc.setQueryData(key, action.pages);
    else if (action.kind === "refetch" && !timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: key });
      }, REFETCH_DEBOUNCE_MS);
    }
  });

  const setFilters = (next: Filters) => {
    const query = filtersToParams(next).toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const endpointUrl = new Map((endpoints.data ?? []).map((e) => [e.id, e.url]));

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Deliveries</h1>

      <form
        aria-label="Filters"
        className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="space-y-1">
          <Label htmlFor="f-endpoint">Endpoint</Label>
          <select
            id="f-endpoint"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={filters.endpoint ?? ""}
            onChange={(e) => setFilters({ ...filters, endpoint: e.target.value || undefined })}
          >
            <option value="">All endpoints</option>
            {(endpoints.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.url}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-status">Status</Label>
          <select
            id="f-status"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            value={filters.status ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, status: (e.target.value || undefined) as Filters["status"] })
            }
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-from">From</Label>
          <Input
            id="f-from"
            type="datetime-local"
            value={toLocalInput(filters.from)}
            onChange={(e) => setFilters({ ...filters, from: fromLocalInput(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-to">To</Label>
          <Input
            id="f-to"
            type="datetime-local"
            value={toLocalInput(filters.to)}
            onChange={(e) => setFilters({ ...filters, to: fromLocalInput(e.target.value) })}
          />
        </div>
      </form>

      {list.error ? <ProblemMessage problem={toProblem(list.error)} /> : null}
      {list.isPending ? <p className="text-sm text-muted-foreground">Loading deliveries…</p> : null}
      {list.data && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No deliveries match these filters.</p>
      ) : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Endpoint
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Attempts
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Last error
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Created
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Next attempt
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} data-delivery={d.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/deliveries/${d.id}`}
                      className="hover:underline"
                      aria-label={`Delivery ${d.id}`}
                    >
                      <DeliveryStatusBadge status={d.status} />
                    </Link>
                  </td>
                  <td className="max-w-64 truncate px-3 py-2">
                    {endpointUrl.get(d.endpoint_id) ?? d.endpoint_id}
                  </td>
                  <td className="px-3 py-2">{d.attempt_count}</td>
                  <td className="px-3 py-2">{d.last_error_class ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(d.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {d.status === "scheduled" && d.next_attempt_at ? formatRelative(d.next_attempt_at) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      ) : null}
    </section>
  );
}
