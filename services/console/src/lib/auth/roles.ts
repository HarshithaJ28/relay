import type { Role } from "./session";

/**
 * What each role may do, mirroring the control plane's requireRole guards
 * (services/control-plane/src/routes). The UI hides what a role cannot do; the API still
 * enforces it, and a 403 is shown with the shared problem component.
 */
export type Action =
  | "endpoints:write" // create, edit, disable, delete, rotate secret, view secret, send test event
  | "catalog:write" // event types and subscriptions
  | "deliveries:replay" // single and bulk replay
  | "users:read"
  | "users:write"
  | "api-keys:manage"
  | "tenant:write"
  | "billing:manage";

const rank: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };

const minimum: Record<Action, Role> = {
  "endpoints:write": "admin",
  "catalog:write": "admin",
  "deliveries:replay": "admin",
  "users:read": "admin",
  "users:write": "owner",
  "api-keys:manage": "owner",
  "tenant:write": "owner",
  "billing:manage": "owner",
};

export function can(role: Role | undefined, action: Action): boolean {
  return role !== undefined && rank[role] >= rank[minimum[action]];
}
