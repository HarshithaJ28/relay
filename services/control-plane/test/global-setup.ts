/**
 * Real PostgreSQL 16 and Valkey for the control-plane tests, the same way the data-plane suite
 * does it: throwaway containers (testcontainers), or running servers named by
 * RELAY_TEST_PG_DSN ("host=... port=...", trust auth, superuser postgres) and
 * RELAY_TEST_VALKEY_URL. The repository's SQL migrations are applied to a fresh database.
 * If a service is unavailable the run fails; nothing is skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import type { TestProject } from "vitest/node";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");
const LOGIN_ROLES = [
  "relay_owner",
  "relay_tenant",
  "relay_control",
  "relay_scheduler",
  "relay_publisher",
  "relay_worker",
  "relay_reaper",
  "relay_retention",
];

declare module "vitest" {
  export interface ProvidedContext {
    pgServer: { host: string; port: number; database: string };
    valkeyUrl: string;
  }
}

const started: StartedTestContainer[] = [];

function parseKeywords(dsn: string): Record<string, string> {
  return Object.fromEntries(
    dsn
      .trim()
      .split(/\s+/)
      .map((kv) => kv.split("=") as [string, string]),
  );
}

async function retry<T>(what: string, fn: () => Promise<T>, seconds = 60): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`${what} not reachable: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export default async function setup(project: TestProject) {
  let host: string;
  let port: number;
  if (process.env.RELAY_TEST_PG_DSN) {
    const kw = parseKeywords(process.env.RELAY_TEST_PG_DSN);
    host = kw.host ?? "127.0.0.1";
    port = Number(kw.port ?? 5432);
  } else {
    const c = await new GenericContainer("postgres:16")
      .withEnvironment({ POSTGRES_HOST_AUTH_METHOD: "trust" })
      .withExposedPorts(5432)
      .start();
    started.push(c);
    host = c.getHost();
    port = c.getMappedPort(5432);
  }
  const admin = new pg.Client({ host, port, user: "postgres", database: "postgres" });
  await retry("PostgreSQL", () => admin.connect());
  const database = `relay_cp_test_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  const su = new pg.Client({ host, port, user: "postgres", database });
  await su.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    const up = text.split("-- migrate:up")[1]?.split("-- migrate:down")[0] ?? "";
    await su.query(up);
  }
  for (const role of LOGIN_ROLES) await su.query(`ALTER ROLE ${role} LOGIN`);
  await su.end();

  let valkeyUrl = process.env.RELAY_TEST_VALKEY_URL;
  if (!valkeyUrl) {
    const v = await new GenericContainer("valkey/valkey:8.1").withExposedPorts(6379).start();
    started.push(v);
    valkeyUrl = `redis://${v.getHost()}:${v.getMappedPort(6379)}/0`;
  }

  project.provide("pgServer", { host, port, database });
  project.provide("valkeyUrl", valkeyUrl);

  return async () => {
    for (const c of started) await c.stop();
    if (process.env.RELAY_TEST_PG_DSN) {
      const cleanup = new pg.Client({ host, port, user: "postgres", database: "postgres" });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await cleanup.end();
    }
  };
}
