# 0004. Python for the data plane, TypeScript for the control plane

Status: Accepted

## Context

The system has two kinds of work. The data plane ingests events and sends webhooks: queue
consumers, timers, an HTTP client with strict SSRF rules, and database functions. The control
plane is a JSON API for the console: accounts, endpoints, deliveries, replay and billing. The
console will be TypeScript (Next.js).

## Decision

- **Data plane in Python 3.12** with asyncio and aiohttp for sending, FastAPI for ingestion, and
  psycopg 3. Python's standard `ipaddress` module and aiohttp's resolver hooks let the sender check
  and pin every address it connects to.
- **Control plane in TypeScript** with Fastify 5, Zod 4 and Drizzle. Its OpenAPI document is
  generated from the Zod schemas, and the console's client is generated from that document, so
  the console and the API share one set of types.
- Both services use the same database functions. Where both sides need the same rules, they
  share test fixtures: the SSRF corpus (`tests/fixtures/ssrf_corpus.json`) and the secret-encryption
  vectors, which each language encrypts and the other decrypts.

## Alternatives considered

- **One language for everything.** Less tooling, but either the console's API loses its generated
  types (Python) or the sender loses the libraries it relies on (Node).
- **Go or Java.** Both are well suited, but Java is excluded for this project, and Go would add a
  third language without removing one.

## Consequences

- Two toolchains in CI: ruff, pytest and pip-audit; tsc, Biome, Vitest and npm audit.
- Rules that exist on both sides (SSRF checks, secret format, API-key format) can drift. The
  shared fixtures catch drift in the parts they cover.
