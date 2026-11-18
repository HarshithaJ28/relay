"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ProblemMessage } from "@/components/problem-message";
import { ReplayButton } from "@/components/replay/replay-button";
import { type Attempt, deliveryKeys, useDelivery } from "@/lib/api/deliveries";
import { toProblem } from "@/lib/api/problem";
import { formatDate } from "@/lib/format";
import { useLiveEvents } from "@/lib/live/context";
import { DeliveryStatusBadge } from "./status-badge";

/** "+2m 05s" between two attempts; durations of a request itself are not stored. */
export function gapLabel(previous: string | undefined, current: string): string {
  if (!previous) return "—";
  const s = Math.max(0, Math.round((Date.parse(current) - Date.parse(previous)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `+${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `+${m}m ${String(sec).padStart(2, "0")}s`;
  return `+${sec}s`;
}

const OUTCOME: Record<string, string> = {
  success: "Delivered",
  retry: "Failed, will retry",
  dead: "Failed, gave up",
  lease_expired: "Worker lease expired",
  deferred: "Deferred (not counted)",
};

export function DeliveryDetailPage({ id }: { id: string }) {
  const q = useDelivery(id);
  const qc = useQueryClient();
  useLiveEvents((e) => {
    if (e.type === "delivery" && e.delivery_id === id)
      void qc.invalidateQueries({ queryKey: deliveryKeys.one(id) });
  });

  if (q.error) return <ProblemMessage problem={toProblem(q.error)} />;
  if (!q.data) return <p className="text-sm text-muted-foreground">Loading delivery…</p>;
  const d = q.data;
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <Link href="/deliveries" className="text-sm text-muted-foreground hover:underline">
          ← Deliveries
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-xl font-semibold">
          Delivery <DeliveryStatusBadge status={d.status} />
        </h1>
        <ReplayButton delivery={d} />
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="break-all">{d.id}</dd>
          <dt className="text-muted-foreground">Message ID</dt>
          <dd className="break-all">{d.message_id}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDate(d.created_at)}</dd>
          {d.replay_of ? (
            <>
              <dt className="text-muted-foreground">Replay of</dt>
              <dd>
                <Link href={`/deliveries/${d.replay_of}`} className="break-all underline">
                  {d.replay_of}
                </Link>
              </dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">Event{d.event.event_type ? `: ${d.event.event_type}` : ""}</h2>
        {d.event.payload_expired ? (
          <p className="rounded-md border border-border bg-muted p-3 text-sm" data-testid="payload-expired">
            The payload is no longer kept
            {d.event.payload_expires_at ? ` (it expired on ${formatDate(d.event.payload_expires_at)})` : ""}.
            The delivery history below remains.
          </p>
        ) : (
          <>
            <pre
              className="max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 text-xs"
              data-testid="payload"
            >
              {JSON.stringify(d.event.payload, null, 2)}
            </pre>
            {d.event.payload_expires_at ? (
              <p className="text-xs text-muted-foreground">
                Kept until {formatDate(d.event.payload_expires_at)}.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">Attempts</h2>
        {d.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attempts yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    #
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Outcome
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    HTTP status
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Error class
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Time
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    After previous
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.attempts.map((a: Attempt, i) => (
                  <tr key={`${a.attempt_no}-${a.created_at}`} className="border-t border-border">
                    <td className="px-3 py-2">{a.attempt_no}</td>
                    <td className="px-3 py-2">{OUTCOME[a.outcome] ?? a.outcome}</td>
                    <td className="px-3 py-2">{a.status_code ?? "—"}</td>
                    <td className="px-3 py-2">{a.error_class ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(a.created_at)}</td>
                    <td className="px-3 py-2">{gapLabel(d.attempts[i - 1]?.created_at, a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">How long each request took is not recorded.</p>
      </div>
    </section>
  );
}
