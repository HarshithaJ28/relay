"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApi } from "../auth/context";
import { unwrap } from "./client";

/**
 * Endpoints. The control plane does not declare response schemas, so responses are checked
 * here. Unknown fields are stripped: a signing secret can never reach the query cache through
 * Endpoint. The two calls that return one (create, rotate) use gcTime 0: once the dialog that
 * started them closes, TanStack Query drops the mutation and the secret in it.
 */
export const Endpoint = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(["enabled", "disabled", "breaker_open"]),
  concurrency_limit: z.number().int(),
  breaker_until: z.string().nullable(),
  signing_secrets: z.array(z.object({ kid: z.string(), expires_at: z.string().nullable() })),
  created_at: z.string(),
});
export type Endpoint = z.infer<typeof Endpoint>;

const WithSecret = Endpoint.extend({ signing_secret: z.string().startsWith("whsec_") });

export const endpointKeys = {
  all: ["endpoints"] as const,
  one: (id: string) => ["endpoints", id] as const,
};

export function useEndpoints() {
  const api = useApi();
  return useQuery({
    queryKey: endpointKeys.all,
    queryFn: async () => z.array(Endpoint).parse(unwrap(await api.GET("/api/v1/endpoints"))),
  });
}

export function useCreateEndpoint() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0, // remove the mutation, and the secret in it, as soon as nothing observes it
    mutationFn: async (body: { url: string; concurrency_limit: number }) => {
      const res = WithSecret.parse(unwrap(await api.POST("/api/v1/endpoints", { body })));
      return { endpoint: Endpoint.parse(res), secret: res.signing_secret };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: endpointKeys.all }),
  });
}

export function useUpdateEndpoint(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { url?: string; concurrency_limit?: number; status?: "enabled" | "disabled" }) =>
      Endpoint.parse(unwrap(await api.PATCH("/api/v1/endpoints/{id}", { params: { path: { id } }, body }))),
    onSuccess: () => qc.invalidateQueries({ queryKey: endpointKeys.all }),
  });
}

export function useDeleteEndpoint() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const r = await api.DELETE("/api/v1/endpoints/{id}", { params: { path: { id } } });
      if (!r.response.ok) unwrap(r);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: endpointKeys.all }),
  });
}

export function useRotateSecret(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    gcTime: 0, // remove the mutation, and the secret in it, as soon as nothing observes it
    mutationFn: async (overlap_hours: number) => {
      const res = WithSecret.parse(
        unwrap(
          await api.POST("/api/v1/endpoints/{id}/rotate-secret", {
            params: { path: { id } },
            body: { overlap_hours },
          }),
        ),
      );
      return { endpoint: Endpoint.parse(res), secret: res.signing_secret };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: endpointKeys.all }),
  });
}

export function useSendTestEvent() {
  const api = useApi();
  return useMutation({
    mutationFn: async (id: string) =>
      z
        .object({ event_id: z.string(), delivery_id: z.string() })
        .parse(unwrap(await api.POST("/api/v1/endpoints/{id}/test", { params: { path: { id } } }))),
  });
}
