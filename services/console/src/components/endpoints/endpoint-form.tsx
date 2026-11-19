"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyProblemToForm, type Problem, toProblem } from "@/lib/api/problem";

const schema = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .url("Enter a full URL, for example https://example.com/webhooks")
    .refine((u) => u.startsWith("https://") || u.startsWith("http://"), "Use an https:// URL"),
  concurrency_limit: z.coerce.number().int().min(1, "At least 1").max(1000, "At most 1000"),
});
export type EndpointValues = z.infer<typeof schema>;

/** Create or edit an endpoint. A URL the server refuses (SSRF checks) is shown on the URL field. */
export function EndpointForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: EndpointValues;
  submitLabel: string;
  onSubmit: (values: EndpointValues) => Promise<unknown>;
}) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const form = useForm<z.input<typeof schema>, unknown, EndpointValues>({
    resolver: zodResolver(schema),
    defaultValues: initial ?? { url: "", concurrency_limit: 10 },
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      await onSubmit(values);
    } catch (e) {
      const p = toProblem(e);
      if (!applyProblemToForm(p, form.setError, { "blocked-destination": "url" })) setProblem(p);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {problem ? <ProblemMessage problem={problem} /> : null}
      <div className="space-y-1.5">
        <Label htmlFor="endpoint-url">URL</Label>
        <Input
          id="endpoint-url"
          inputMode="url"
          placeholder="https://example.com/webhooks"
          aria-invalid={!!errors.url}
          aria-describedby={errors.url ? "endpoint-url-error" : undefined}
          {...form.register("url")}
        />
        {errors.url ? (
          <p id="endpoint-url-error" className="text-sm text-destructive">
            {errors.url.message}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="endpoint-concurrency">Concurrent deliveries</Label>
        <Input
          id="endpoint-concurrency"
          type="number"
          min={1}
          max={1000}
          aria-invalid={!!errors.concurrency_limit}
          {...form.register("concurrency_limit")}
        />
        {errors.concurrency_limit ? (
          <p className="text-sm text-destructive">{errors.concurrency_limit.message}</p>
        ) : (
          <p className="text-xs text-muted-foreground">How many requests Relay sends to this URL at once.</p>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
