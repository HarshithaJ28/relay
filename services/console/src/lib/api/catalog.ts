"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import { unwrap } from "./client";

// These routes answer in camelCase (Drizzle rows); the schemas follow them exactly.

// ---------------------------------------------------------------- API keys
export const SCOPES = ["events:write", "events:read"] as const;
export const ApiKey = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKey>;
const CreatedKey = z.object({ id: z.string(), key: z.string().startsWith("rly_"), prefix: z.string() });

export function useApiKeys(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["api-keys"],
    enabled,
    queryFn: async () => z.array(ApiKey).parse(unwrap(await api.GET("/api/v1/api-keys"))),
  });
}

export function useCreateApiKey() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0, // the key is in the result: drop it as soon as nothing observes the mutation
    mutationFn: async (body: { name: string; scopes: Array<(typeof SCOPES)[number]> }) =>
      CreatedKey.parse(unwrap(await api.POST("/api/v1/api-keys", { body }))).key,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

export function useRevokeApiKey() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await api.DELETE("/api/v1/api-keys/{id}", { params: { path: { id } } });
      if (!r.response.ok) unwrap(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

// ---------------------------------------------------------------- users
export const User = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["owner", "admin", "viewer"]),
  createdAt: z.string(),
});
export type User = z.infer<typeof User>;

export function useUsers(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["users"],
    enabled,
    queryFn: async () => z.array(User).parse(unwrap(await api.GET("/api/v1/users"))),
  });
}

export function useAddUser() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0, // the request carried a password
    mutationFn: async (body: { email: string; password: string; role: "admin" | "viewer" }) => {
      unwrap(await api.POST("/api/v1/users", { body }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useRemoveUser() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await api.DELETE("/api/v1/users/{id}", { params: { path: { id } } });
      if (!r.response.ok) unwrap(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// ---------------------------------------------------------------- event types
/** The control plane's rule for event type names. */
export const EVENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const EventType = z.object({ id: z.string(), name: z.string(), createdAt: z.string() });
export type EventType = z.infer<typeof EventType>;

export function useEventTypes() {
  const api = useApi();
  return useQuery({
    queryKey: ["event-types"],
    queryFn: async () => z.array(EventType).parse(unwrap(await api.GET("/api/v1/event-types"))),
  });
}

export function useAddEventType() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      unwrap(await api.POST("/api/v1/event-types", { body: { name } }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["event-types"] }),
  });
}

// ---------------------------------------------------------------- subscriptions
export const Subscription = z.object({
  id: z.string(),
  endpointId: z.string(),
  eventType: z.string(),
  createdAt: z.string(),
});
export type Subscription = z.infer<typeof Subscription>;

export function useSubscriptions() {
  const api = useApi();
  return useQuery({
    queryKey: ["subscriptions"],
    queryFn: async () => z.array(Subscription).parse(unwrap(await api.GET("/api/v1/subscriptions"))),
  });
}

export function useAddSubscription() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { endpoint_id: string; event_type: string }) => {
      unwrap(await api.POST("/api/v1/subscriptions", { body }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}

export function useRemoveSubscription() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await api.DELETE("/api/v1/subscriptions/{id}", { params: { path: { id } } });
      if (!r.response.ok) unwrap(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}
