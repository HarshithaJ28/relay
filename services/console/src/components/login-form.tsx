"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Problem } from "@/lib/api/problem";
import { useSession } from "@/lib/auth/context";
import { AuthError } from "@/lib/auth/session";

const schema = z.object({
  email: z.string().trim().email("Enter an email address"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const { session } = useSession();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [lockedFor, setLockedFor] = useState(0);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  useEffect(() => {
    if (lockedFor <= 0) return;
    const t = setTimeout(() => setLockedFor((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockedFor]);

  const submit = form.handleSubmit(async ({ email, password }) => {
    setProblem(null);
    try {
      await session.login(email, password);
      onSuccess();
    } catch (e) {
      if (e instanceof AuthError) {
        setProblem(e.problem);
        if (e.retryAfter) setLockedFor(e.retryAfter);
      } else {
        setProblem({ type: "/problems/network", title: "Cannot reach the server", status: 0 });
      }
    }
  });

  const minutes = Math.ceil(lockedFor / 60);
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {problem ? <ProblemMessage problem={problem} /> : null}
      {lockedFor > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          Too many failed attempts. Try again in {minutes} minute{minutes === 1 ? "" : "s"}.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          aria-invalid={!!form.formState.errors.email}
          {...form.register("email")}
        />
        {form.formState.errors.email ? (
          <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={!!form.formState.errors.password}
          {...form.register("password")}
        />
        {form.formState.errors.password ? (
          <p className="text-sm text-destructive">{form.formState.errors.password.message}</p>
        ) : null}
      </div>
      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting || lockedFor > 0}>
        {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
