"use client";
import type { MessageIdMode } from "@/lib/api/replay";

const TEXT: Record<MessageIdMode, { title: string; body: string }> = {
  new: {
    title: "New message ID",
    body: "The receiver sees a new message and processes it again, even if it removes duplicates by ID.",
  },
  reuse: {
    title: "Same message ID",
    body: "A receiver that removes duplicates by ID drops it if it already processed the original, so nothing happens twice.",
  },
};

/** The message-id choice, explained before anything is sent. */
export function MessageIdChoice({
  value,
  onChange,
  recommended,
  reason,
}: {
  value: MessageIdMode;
  onChange: (m: MessageIdMode) => void;
  recommended: MessageIdMode;
  reason: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Message ID</legend>
      <p className="text-sm text-muted-foreground">{reason}</p>
      {(["new", "reuse"] as const).map((m) => (
        <label
          key={m}
          className="flex cursor-pointer gap-3 rounded-md border border-border p-3 text-sm has-checked:border-accent"
        >
          <input
            type="radio"
            name="message-id"
            value={m}
            checked={value === m}
            onChange={() => onChange(m)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">
              {TEXT[m].title}
              {m === recommended ? " (recommended)" : ""}
            </span>
            <span className="block text-muted-foreground">{TEXT[m].body}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
