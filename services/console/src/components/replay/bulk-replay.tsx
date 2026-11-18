"use client";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { Filters } from "@/lib/api/deliveries";
import { type Problem, toProblem } from "@/lib/api/problem";
import {
  type BulkParams,
  type BulkResult,
  bulkKey,
  defaultMode,
  type MessageIdMode,
  useBulkReplay,
} from "@/lib/api/replay";
import { RequireRole } from "@/lib/auth/require-role";
import { MessageIdChoice } from "./message-id-choice";

/**
 * Bulk replay of finished deliveries matching the list's endpoint and time filters. The counts
 * come first (a dry run); the replay button exists only for a preview of exactly the current
 * settings, so changing anything means checking again.
 */
export function BulkReplay({ filters }: { filters: Filters }) {
  const [open, setOpen] = useState(false);
  return (
    <RequireRole action="deliveries:replay">
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RotateCcw className="size-4" /> Bulk replay
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <BulkDialog filters={filters} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </RequireRole>
  );
}

function BulkDialog({ filters, onDone }: { filters: Filters; onDone: () => void }) {
  const [status, setStatus] = useState<"dead" | "succeeded">("dead");
  const [mode, setMode] = useState<MessageIdMode>(defaultMode("dead"));
  const [preview, setPreview] = useState<{ key: string; result: BulkResult } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const bulk = useBulkReplay();
  const params: BulkParams = {
    endpoint_id: filters.endpoint,
    from: filters.from,
    to: filters.to,
    status,
    message_id: mode,
  };
  const current = preview && preview.key === bulkKey(params) ? preview.result : null;

  const run = async (dryRun: boolean) => {
    setProblem(null);
    try {
      const result = await bulk.mutateAsync({ params, dryRun });
      if (dryRun) setPreview({ key: bulkKey(params), result });
      else {
        toast.success(`${result.replayed} ${result.replayed === 1 ? "delivery" : "deliveries"} replayed`);
        onDone();
      }
    } catch (e) {
      setProblem(toProblem(e));
    }
  };

  return (
    <DialogContent
      title="Bulk replay"
      description={`Replays finished deliveries${filters.endpoint ? " to the selected endpoint" : ""}${filters.from || filters.to ? " in the selected time range" : ""}. Nothing is sent until you confirm the counts.`}
    >
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Which deliveries</legend>
          {(["dead", "succeeded"] as const).map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="bulk-status"
                value={s}
                checked={status === s}
                onChange={() => {
                  setStatus(s);
                  setMode(defaultMode(s));
                }}
              />
              {s === "dead" ? "Failed deliveries" : "Succeeded deliveries"}
            </label>
          ))}
        </fieldset>
        <MessageIdChoice
          value={mode}
          onChange={setMode}
          recommended={defaultMode(status)}
          reason={
            status === "dead"
              ? "Failed deliveries may have reached the receiver, so reusing their IDs avoids processing anything twice."
              : "Succeeded deliveries reached the receiver, so new IDs make sure the replays are processed."
          }
        />
        {problem ? <ProblemMessage problem={problem} /> : null}
        {current ? (
          <dl
            className="grid grid-cols-[1fr_max-content] gap-x-4 gap-y-1 rounded-md border border-border p-3 text-sm"
            data-testid="bulk-counts"
          >
            <dt>Will be replayed</dt>
            <dd className="font-medium">{current.replayable}</dd>
            <dt>Payload expired, skipped</dt>
            <dd>{current.expired}</dd>
            {status === "dead" ? (
              <>
                <dt>Already succeeded, skipped</dt>
                <dd>{current.already_succeeded}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={bulk.isPending} onClick={() => void run(true)}>
            {current ? "Check again" : "Check"}
          </Button>
          {current ? (
            <Button disabled={bulk.isPending || current.replayable === 0} onClick={() => void run(false)}>
              Replay {current.replayable}
            </Button>
          ) : null}
        </div>
      </div>
    </DialogContent>
  );
}
