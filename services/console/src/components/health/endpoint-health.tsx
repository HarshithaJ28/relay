"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProblemMessage } from "@/components/problem-message";
import { Badge } from "@/components/ui/badge";
import { useEndpoint } from "@/lib/api/endpoints";
import {
  applyBreakerEvent,
  breakerState,
  errorRows,
  type Health,
  healthKey,
  useHealth,
} from "@/lib/api/health";
import { toProblem } from "@/lib/api/problem";
import { formatDate, formatRelative } from "@/lib/format";
import { useLiveEvents } from "@/lib/live/context";

/** Debounce for refetching health after delivery events, so a burst costs one request. */
export const HEALTH_REFETCH_MS = 1_000;

export function BreakerPanel({ breaker }: { breaker: Health["breaker"] }) {
  // Re-render when an open breaker's time runs out, so it turns into "probing" on time.
  const [, tick] = useState(0);
  useEffect(() => {
    if (breaker.state !== "open" || !breaker.until) return;
    const ms = Date.parse(breaker.until) - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [breaker]);

  const view = breakerState(breaker);
  return (
    <div className="space-y-1 rounded-lg border border-border p-4" data-testid="breaker">
      <div className="flex items-center gap-2">
        <span className="font-medium">Circuit breaker</span>
        {view.state === "closed" ? <Badge tone="success">Closed</Badge> : null}
        {view.state === "open" ? <Badge tone="danger">Open</Badge> : null}
        {view.state === "probing" ? <Badge tone="warning">Probing</Badge> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {view.state === "closed" ? "Deliveries are sent normally." : null}
        {view.state === "open"
          ? `Too many recent failures, so nothing is sent to this endpoint until ${formatDate(view.until)} (${formatRelative(view.until)}).`
          : null}
        {view.state === "probing"
          ? "The pause is over: Relay is sending one delivery as a probe. If it succeeds the breaker closes; if not, it opens again for longer."
          : null}
      </p>
    </div>
  );
}

export function EndpointHealthPage({ id }: { id: string }) {
  const endpoint = useEndpoint(id);
  const health = useHealth(id);
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useLiveEvents((event) => {
    if (event.endpoint_id !== id) return;
    if (event.type === "breaker") {
      qc.setQueryData(healthKey(id), (h: Health | undefined) => applyBreakerEvent(h, event));
    }
    // A successful probe closes the breaker without an event of its own, so any change for this
    // endpoint refetches (debounced).
    if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: ["endpoints", id] });
      }, HEALTH_REFETCH_MS);
    }
  });

  const problem = health.error ?? endpoint.error;
  if (problem) return <ProblemMessage problem={toProblem(problem)} />;
  if (!health.data) return <p className="text-sm text-muted-foreground">Loading health…</p>;
  const h = health.data;
  const rows = errorRows(h.errors_by_class);
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <Link href="/endpoints" className="text-sm text-muted-foreground hover:underline">
          ← Endpoints
        </Link>
        <h1 className="text-xl font-semibold break-all">{endpoint.data?.url ?? "Endpoint"}</h1>
      </div>

      <BreakerPanel breaker={h.breaker} />

      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <dt className="text-sm text-muted-foreground">Success rate, last {h.window_hours} h</dt>
          <dd className="text-2xl font-semibold" data-testid="success-rate">
            {h.success_rate === null ? "—" : `${(h.success_rate * 100).toFixed(1)}%`}
          </dd>
          <dd className="text-xs text-muted-foreground">
            {h.successes} of {h.attempts} attempts
          </dd>
        </div>
        <div className="rounded-lg border border-border p-4">
          <dt className="text-sm text-muted-foreground">Active deliveries</dt>
          <dd className="text-2xl font-semibold">{h.active_deliveries}</dd>
          <dd className="text-xs text-muted-foreground">Scheduled, queued or sending</dd>
        </div>
        <div className="rounded-lg border border-border p-4">
          <dt className="text-sm text-muted-foreground">Failed attempts, last {h.window_hours} h</dt>
          <dd className="text-2xl font-semibold">{h.attempts - h.successes}</dd>
          <dd className="text-xs">
            <Link href={`/deliveries?endpoint=${id}`} className="underline">
              See this endpoint&apos;s deliveries
            </Link>
          </dd>
        </div>
      </dl>

      <div className="space-y-2">
        <h2 className="font-semibold">Errors by class, last {h.window_hours} h</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No errors.</p>
        ) : (
          <ul className="space-y-2" aria-label="Errors by class">
            {rows.map((r) => (
              <li key={r.errorClass} className="space-y-1 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="break-all">{r.errorClass}</span>
                  <span className="text-muted-foreground">{r.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted" aria-hidden>
                  <div
                    className="h-1.5 rounded-full bg-destructive"
                    style={{ width: `${Math.round(r.share * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
