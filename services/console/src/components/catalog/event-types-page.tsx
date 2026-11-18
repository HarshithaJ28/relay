"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EVENT_TYPE, useAddEventType, useEventTypes } from "@/lib/api/catalog";
import { applyProblemToForm, toProblem } from "@/lib/api/problem";
import { RequireRole } from "@/lib/auth/require-role";
import { formatDate } from "@/lib/format";
import { DataTable } from "./table";

const schema = z.object({
  name: z
    .string()
    .trim()
    .regex(
      EVENT_TYPE,
      "Start with a letter or digit; then letters, digits, dots, colons, dashes or underscores (up to 200)",
    ),
});

export function EventTypesPage() {
  const types = useEventTypes();
  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Event types</h1>
        <p className="text-sm text-muted-foreground">
          The kinds of event your backend sends, such as order.paid.
        </p>
      </div>
      <RequireRole action="catalog:write">
        <AddEventType />
      </RequireRole>
      {types.error ? <ProblemMessage problem={toProblem(types.error)} /> : null}
      {types.data?.length === 0 ? <p className="text-sm text-muted-foreground">No event types yet.</p> : null}
      {types.data?.length ? (
        <DataTable
          label="Event types"
          headers={["Name", "Added"]}
          rows={types.data.map((t) => [<code key="n">{t.name}</code>, formatDate(t.createdAt)])}
        />
      ) : null}
    </section>
  );
}

function AddEventType() {
  const add = useAddEventType();
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "" },
  });
  const fieldError = form.formState.errors.name;
  const formError = form.formState.errors.root;
  return (
    <form
      noValidate
      aria-label="Add event type"
      className="flex flex-wrap items-end gap-2"
      onSubmit={form.handleSubmit(async ({ name }) => {
        try {
          await add.mutateAsync(name);
          toast.success(`Added ${name}`);
          form.reset();
        } catch (e) {
          const p = toProblem(e);
          if (!applyProblemToForm(p, form.setError, { exists: "name" })) {
            form.setError("root", { message: p.detail ?? p.title });
          }
        }
      })}
    >
      <div className="min-w-56 flex-1 space-y-1.5">
        <Label htmlFor="event-type-name">New event type</Label>
        <Input
          id="event-type-name"
          placeholder="order.paid"
          aria-invalid={!!fieldError}
          aria-describedby={fieldError ? "event-type-error" : undefined}
          {...form.register("name")}
        />
      </div>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        Add
      </Button>
      {fieldError ? (
        <p id="event-type-error" className="w-full text-sm text-destructive">
          {fieldError.message}
        </p>
      ) : null}
      {formError ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {formError.message}
        </p>
      ) : null}
    </form>
  );
}
