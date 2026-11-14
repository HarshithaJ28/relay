# 0006. The console is served from the same cluster, not Vercel

Status: Accepted, not yet built

## Context

The console is a Next.js application. Vercel is the default host for Next.js, but the console
talks to the control plane with an in-memory access token and an httpOnly refresh cookie scoped
to `/api/v1/auth` with SameSite=Strict, and the project must cost nothing to run.

## Decision

Build the console with `output: "standalone"`, publish it as `ghcr.io/harshithaj28/relay-console`,
and serve it from the same k3s cluster and the same origin as the API (ADR 0005).

## Alternatives considered

- **Vercel.** A separate origin would need CORS and a cross-site cookie (SameSite=None), which
  weakens the refresh cookie. Server-side features would run in a second environment to monitor,
  and the free tier's limits and terms are outside the project's control.

## Consequences

- One origin: no CORS, and the refresh cookie stays SameSite=Strict.
- The console is deployed, monitored and rolled back with the rest of the system.
- There is no global edge cache; the console is served from one node.
