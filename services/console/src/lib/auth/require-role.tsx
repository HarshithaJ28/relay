"use client";
import type { ReactNode } from "react";
import { useSession } from "./context";
import { type Action, can } from "./roles";

/** Renders children only for roles allowed to do `action`; the API enforces it as well. */
export function RequireRole({
  action,
  children,
  fallback = null,
}: {
  action: Action;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { state } = useSession();
  const role = state.status === "authenticated" ? state.user.role : undefined;
  return <>{can(role, action) ? children : fallback}</>;
}
