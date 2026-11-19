"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ProblemMessage } from "@/components/problem-message";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAddUser, useRemoveUser, useUsers } from "@/lib/api/catalog";
import { applyProblemToForm, type Problem, toProblem } from "@/lib/api/problem";
import { useSession } from "@/lib/auth/context";
import { RequireRole } from "@/lib/auth/require-role";
import { RoleGate } from "@/lib/auth/role-gate";
import { formatDate } from "@/lib/format";
import { DataTable } from "./table";

export function UsersPage() {
  return (
    <RoleGate action="users:read">
      <Users />
    </RoleGate>
  );
}

function Users() {
  const { state } = useSession();
  const me = state.status === "authenticated" ? state.user.id : undefined;
  const users = useUsers(true);
  const remove = useRemoveUser();
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Users</h1>
          <p className="text-sm text-muted-foreground">
            Owners manage keys, users and billing; admins manage endpoints and replay; viewers read.
          </p>
        </div>
        <RequireRole action="users:write">
          <Button onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add user
          </Button>
        </RequireRole>
      </div>
      {users.error ? <ProblemMessage problem={toProblem(users.error)} /> : null}
      {users.data?.length ? (
        <DataTable
          label="Users"
          headers={["Email", "Role", "Added", ""]}
          rows={users.data.map((u) => [
            <span key="e" className="break-all">
              {u.email}
              {u.id === me ? <span className="text-muted-foreground"> (you)</span> : null}
            </span>,
            u.role,
            formatDate(u.createdAt),
            u.id === me ? null : (
              <RequireRole key="r" action="users:write">
                <ConfirmButton
                  label="Remove"
                  title="Remove user"
                  description={`${u.email} can no longer sign in to this account.`}
                  onConfirm={async () => {
                    await remove.mutateAsync(u.id);
                    toast.success("User removed");
                  }}
                />
              </RequireRole>
            ),
          ])}
        />
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding ? <AddUser onDone={() => setAdding(false)} /> : null}
      </Dialog>
    </section>
  );
}

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Enter an email address").max(254),
  password: z.string().min(12, "At least 12 characters").max(200),
  role: z.enum(["admin", "viewer"]),
});
type Values = z.infer<typeof schema>;

function AddUser({ onDone }: { onDone: () => void }) {
  const add = useAddUser();
  const [problem, setProblem] = useState<Problem | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", role: "viewer" },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <DialogContent
      title="Add user"
      description="Relay sends no email: give the new user this password yourself and ask them to keep it private."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={form.handleSubmit(async (values) => {
          setProblem(null);
          try {
            await add.mutateAsync(values);
            toast.success("User added");
            onDone();
          } catch (e) {
            const p = toProblem(e);
            if (!applyProblemToForm(p, form.setError, { "email-taken": "email" })) setProblem(p);
          }
        })}
      >
        {problem ? <ProblemMessage problem={problem} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor="user-email">Email</Label>
          <Input
            id="user-email"
            type="email"
            autoComplete="off"
            aria-invalid={!!errors.email}
            {...form.register("email")}
          />
          {errors.email ? <p className="text-sm text-destructive">{errors.email.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-password">Password</Label>
          <Input
            id="user-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...form.register("password")}
          />
          {errors.password ? <p className="text-sm text-destructive">{errors.password.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-role">Role</Label>
          <select
            id="user-role"
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            {...form.register("role")}
          >
            <option value="viewer">Viewer — reads everything, changes nothing</option>
            <option value="admin">Admin — manages endpoints, subscriptions and replay</option>
          </select>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            Add user
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
