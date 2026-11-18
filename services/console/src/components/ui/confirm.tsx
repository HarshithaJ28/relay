"use client";
import { useState } from "react";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { type Problem, toProblem } from "@/lib/api/problem";

/** A destructive action behind a confirmation; problems stay in the dialog. */
export function ConfirmButton({
  label,
  title,
  description,
  confirmLabel = label,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        onClick={() => {
          setProblem(null);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent title={title} description={description}>
            <div className="space-y-4">
              {problem ? <ProblemMessage problem={problem} /> : null}
              <div className="flex justify-end">
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onConfirm();
                      setOpen(false);
                    } catch (e) {
                      setProblem(toProblem(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {confirmLabel}
                </Button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
