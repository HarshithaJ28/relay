"use client";
import type { ReactNode } from "react";
import { useSession } from "./context";
import { type Action, can } from "./roles";

const NEEDS: Partial<Record<Action, string>> = {
  "api-keys:manage": "owner",
  "users:read": "admin or owner",
};

/** For a whole page: roles that cannot use it see why, and the page never loads its data. */
export function RoleGate({ action, children }: { action: Action; children: ReactNode }) {
  const { state } = useSession();
  const role = state.status === "authenticated" ? state.user.role : undefined;
  if (can(role, action)) return <>{children}</>;
  return (
    <p role="status" className="rounded-md border border-border bg-muted p-4 text-sm">
      This page needs the {NEEDS[action] ?? "admin"} role.
    </p>
  );
}
