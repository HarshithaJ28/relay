import { CircleAlert } from "lucide-react";
import type { Problem } from "@/lib/api/problem";

/** The one place problem details are shown: title, detail and, for 403, a role hint. */
export function ProblemMessage({ problem }: { problem: Problem }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium">{problem.title}</p>
        {problem.detail ? <p className="text-muted-foreground">{problem.detail}</p> : null}
        {problem.status === 403 ? (
          <p className="text-muted-foreground">Your role does not allow this. Ask an owner.</p>
        ) : null}
      </div>
    </div>
  );
}
