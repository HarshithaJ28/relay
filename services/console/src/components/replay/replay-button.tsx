"use client";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { DeliveryDetail } from "@/lib/api/deliveries";
import { type Problem, toProblem } from "@/lib/api/problem";
import {
  defaultMode,
  expiredFromProblem,
  type MessageIdMode,
  replayBlocked,
  useReplay,
} from "@/lib/api/replay";
import { RequireRole } from "@/lib/auth/require-role";
import { formatDate } from "@/lib/format";
import { MessageIdChoice } from "./message-id-choice";

/** Replay one finished delivery. Disabled, with the date, once its payload has expired. */
export function ReplayButton({ delivery }: { delivery: DeliveryDetail }) {
  const [open, setOpen] = useState(false);
  const [expiredAt, setExpiredAt] = useState<string | null | undefined>(undefined); // set by a 410
  const blocked = replayBlocked(delivery);
  if (blocked?.reason === "active") return null;
  const expired =
    blocked?.reason === "expired" ? { at: blocked.at } : expiredAt !== undefined ? { at: expiredAt } : null;

  return (
    <RequireRole action="deliveries:replay">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={expired !== null} onClick={() => setOpen(true)}>
          <RotateCcw className="size-4" /> Replay
        </Button>
        {expired ? (
          <span className="text-sm text-muted-foreground" data-testid="replay-expired">
            Cannot replay: the payload expired{expired.at ? ` on ${formatDate(expired.at)}` : ""}.
          </span>
        ) : null}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <ReplayDialog
            delivery={delivery}
            onExpired={(at) => {
              setExpiredAt(at);
              setOpen(false);
            }}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </RequireRole>
  );
}

function ReplayDialog({
  delivery,
  onExpired,
  onDone,
}: {
  delivery: DeliveryDetail;
  onExpired: (at: string | null) => void;
  onDone: () => void;
}) {
  const recommended = defaultMode(delivery.status);
  const [mode, setMode] = useState<MessageIdMode>(recommended);
  const [problem, setProblem] = useState<Problem | null>(null);
  const replay = useReplay(delivery.id);
  const reason =
    delivery.status === "succeeded"
      ? "This delivery succeeded, so the receiver already has it. A new ID makes sure the replay is processed."
      : "This delivery failed. The receiver may still have received it (a timeout or 5xx does not say), so reusing the ID avoids processing it twice.";

  return (
    <DialogContent
      title="Replay delivery"
      description="Relay sends the same payload again as a new delivery. The original and its history do not change."
    >
      <div className="space-y-4">
        <MessageIdChoice value={mode} onChange={setMode} recommended={recommended} reason={reason} />
        {problem ? <ProblemMessage problem={problem} /> : null}
        <div className="flex justify-end">
          <Button
            disabled={replay.isPending}
            onClick={async () => {
              setProblem(null);
              try {
                const r = await replay.mutateAsync(mode);
                toast.success("Replay scheduled", {
                  description: <Link href={`/deliveries/${r.delivery_id}`}>Open the new delivery</Link>,
                });
                onDone();
              } catch (e) {
                const p = toProblem(e);
                const expired = expiredFromProblem(p);
                if (expired) onExpired(expired.at);
                else setProblem(p);
              }
            }}
          >
            Replay
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
