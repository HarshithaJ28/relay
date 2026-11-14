# 0003. Row-level security and least-privilege roles for tenant isolation

Status: Accepted

## Context

All tenants share one database. A missing `WHERE tenant_id = ...` in any query, in either
service, would expose another tenant's endpoints, payloads or secrets. Application-level
filtering alone puts that guarantee on every line of query code.

## Decision

- Every tenant-scoped table has row-level security enabled and forced. The policies compare
  `tenant_id` with the transaction setting `app.tenant_id`, which the API sets from the
  authenticated principal.
- Each process connects as its own role with only the grants it needs:
  - `relay_tenant` for ingestion;
  - `relay_control` for the control-plane API;
  - `relay_scheduler`, `relay_publisher`, `relay_worker`, `relay_reaper` and `relay_retention` for the
    data-plane processes;
  - `relay_auth` owns the few functions that run before a tenant is known (registration, login lookup,
    session rotation, Stripe events).
- No role is a superuser or has BYPASSRLS. The worker has no table privileges at all, only EXECUTE
  on its functions.
- A test calls every control-plane route as another tenant with this tenant's ids and expects 404.

## Alternatives considered

- **A schema or database per tenant.** Stronger isolation, but migrations and connection pools
  grow with the number of tenants, which does not fit one small node.
- **Application-level filtering only.** Simpler, but one forgotten filter is a cross-tenant leak.

## Consequences

- A query that forgets to set `app.tenant_id` sees no rows instead of all rows.
- Policies and grants are part of every migration and must be tested, which they are (`tests/db`).
- Superusers still bypass row-level security, so no application process may connect as one.
