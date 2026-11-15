import type { Action } from "@/lib/auth/roles";

export interface NavItem {
  href: string;
  label: string;
  /** Hidden for roles that cannot do this; undefined means every role. */
  action?: Action;
}

export const NAV: NavItem[] = [
  { href: "/", label: "Overview" },
  { href: "/endpoints", label: "Endpoints" },
  { href: "/deliveries", label: "Deliveries" },
  { href: "/event-types", label: "Event types" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/api-keys", label: "API keys", action: "api-keys:manage" },
  { href: "/users", label: "Users", action: "users:read" },
];
