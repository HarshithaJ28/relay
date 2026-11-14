# 0005. One k3s node on Oracle Cloud Always Free for hosting

Status: Accepted, not yet deployed

## Context

The project must run publicly at no cost, with a real Kubernetes deployment (Helm, a
NetworkPolicy for the second SSRF layer, rolling updates), and must not stop when a free trial ends.

## Decision

- Run k3s on one Oracle Cloud Always Free Ampere A1 machine (planned at 2 OCPU and 12 GB; check
  the current allowance at sign-up).
- Traefik, which ships with k3s, serves one origin: `/` the console, `/api` the control plane and
  `/ingest` ingestion. A free DuckDNS subdomain with a Let's Encrypt certificate gives it a name.
- Deploy with one Helm chart over SSH from CI. Terraform state for Oracle lives in OCI Object
  Storage through its S3-compatible API.
- A static GitHub Pages page explains outages.
- An AWS Terraform configuration exists for comparison. CI validates it and never applies it.

## Alternatives considered

- **Free tiers that sleep or expire** (managed Kubernetes trials, platforms that stop idle apps).
  They either cost money after the trial or cannot run long-lived workers and a broker.
- **AWS free tier.** It expires and can bill unexpectedly, so it stays validate-only.

## Consequences

- One node is a single point of failure. Nothing here is a high-availability claim.
- Images must be multi-architecture (arm64 and amd64), which CI already publishes.
- Oracle may reclaim idle Always Free machines. The outage page and a repeatable deploy are the
  mitigation.
