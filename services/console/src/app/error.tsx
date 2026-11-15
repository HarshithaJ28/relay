"use client";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { toProblem } from "@/lib/api/problem";

export default function ErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg space-y-4 p-8">
      <ProblemMessage problem={toProblem(error)} />
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
