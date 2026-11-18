"use client";
import { useState } from "react";
import { toast } from "sonner";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm";
import { Label } from "@/components/ui/label";
import {
  useAddSubscription,
  useEventTypes,
  useRemoveSubscription,
  useSubscriptions,
} from "@/lib/api/catalog";
import { useEndpoints } from "@/lib/api/endpoints";
import { type Problem, toProblem } from "@/lib/api/problem";
import { RequireRole } from "@/lib/auth/require-role";
import { formatDate } from "@/lib/format";
import { DataTable } from "./table";

const SELECT = "h-9 w-full rounded-md border border-border bg-background px-2 text-sm";

export function SubscriptionsPage() {
  const subs = useSubscriptions();
  const endpoints = useEndpoints();
  const remove = useRemoveSubscription();
  const url = new Map((endpoints.data ?? []).map((e) => [e.id, e.url]));
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Subscriptions</h1>
        <p className="text-sm text-muted-foreground">Which event types are delivered to which endpoints.</p>
      </div>
      <RequireRole action="catalog:write">
        <AddSubscription />
      </RequireRole>
      {subs.error ? <ProblemMessage problem={toProblem(subs.error)} /> : null}
      {subs.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No subscriptions yet.</p>
      ) : null}
      {subs.data?.length ? (
        <DataTable
          label="Subscriptions"
          headers={["Event type", "Endpoint", "Added", ""]}
          rows={subs.data.map((s) => [
            <code key="t">{s.eventType}</code>,
            <span key="u" className="break-all">
              {url.get(s.endpointId) ?? s.endpointId}
            </span>,
            formatDate(s.createdAt),
            <RequireRole key="r" action="catalog:write">
              <ConfirmButton
                label="Remove"
                title="Remove subscription"
                description={`${s.eventType} events are no longer delivered to this endpoint. Deliveries already made are kept.`}
                onConfirm={async () => {
                  await remove.mutateAsync(s.id);
                  toast.success("Subscription removed");
                }}
              />
            </RequireRole>,
          ])}
        />
      ) : null}
    </section>
  );
}

function AddSubscription() {
  const endpoints = useEndpoints();
  const types = useEventTypes();
  const add = useAddSubscription();
  const [endpoint, setEndpoint] = useState("");
  const [type, setType] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const live = (endpoints.data ?? []).filter((e) => e.status !== "disabled");
  if (endpoints.data && types.data && (live.length === 0 || types.data.length === 0)) {
    return (
      <p className="text-sm text-muted-foreground">
        To subscribe, first add {live.length === 0 ? "an endpoint" : "an event type"}.
      </p>
    );
  }
  return (
    <form
      aria-label="Add subscription"
      className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setProblem(null);
        try {
          await add.mutateAsync({ endpoint_id: endpoint, event_type: type });
          toast.success("Subscribed");
          setType("");
        } catch (err) {
          setProblem(toProblem(err));
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="sub-type">Event type</Label>
        <select
          id="sub-type"
          className={SELECT}
          value={type}
          onChange={(e) => setType(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {(types.data ?? []).map((t) => (
            <option key={t.id} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sub-endpoint">Endpoint</Label>
        <select
          id="sub-endpoint"
          className={SELECT}
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          required
        >
          <option value="">Choose…</option>
          {live.map((e) => (
            <option key={e.id} value={e.id}>
              {e.url}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={add.isPending || !endpoint || !type}>
        Subscribe
      </Button>
      {problem ? (
        <div className="sm:col-span-3">
          <ProblemMessage problem={problem} />
        </div>
      ) : null}
    </form>
  );
}
