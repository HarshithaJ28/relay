"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A signing secret, shown once. It lives only in the parent's state while this is on screen:
 * not logged, not stored, not put in a URL. Closing the dialog drops it for good.
 */
export function SecretOnce({
  secret,
  onDone,
  what = "signing secret",
  again = "to get a new one, rotate the secret",
}: {
  secret: string;
  onDone: () => void;
  /** What the value is, in the sentence "Copy this … now." */
  what?: string;
  /** How to get another, after "It is not shown again;". */
  again?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Copy this {what} now. It is not shown again; {again}.
      </p>
      <div className="flex items-center gap-2">
        <code
          data-testid="signing-secret"
          className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 text-sm"
        >
          {secret}
        </code>
        <Button
          variant="outline"
          size="icon"
          aria-label={copied ? "Copied" : `Copy ${what}`}
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDone}>I have saved it</Button>
      </div>
    </div>
  );
}
