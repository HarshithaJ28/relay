import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeEach, inject } from "vitest";
import { buildApp, type Deps } from "../src/app.js";
import { createInvite } from "../src/cli.js";
import { type Config, loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { type LoginLimiter, type LoginLimits, valkeyLoginLimiter } from "../src/loginLimit.js";
import { Keyring } from "../src/secrets.js";

/** The same synthetic master key the data-plane tests use (tests/conftest.py TEST_KEYRING). */
export const TEST_KEYRING_TEXT = `test-k1:${Buffer.from([...Array(32).keys()]).toString("base64")}`;
export const keyring = Keyring.parse(TEST_KEYRING_TEXT);

const server = inject("pgServer");
export const dsn = (user: string) =>
  `host=${server.host} port=${server.port} dbname=${server.database} user=${user}`;

export const su = new pg.Pool({
  host: server.host,
  port: server.port,
  database: server.database,
  user: "postgres",
  max: 4,
});
const appPool = createPool(dsn("relay_control"));

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      RELAY_CONTROL_DSN: dsn("relay_control"),
      RELAY_JWT_SECRET: "test-secret-test-secret-test-secret-0123",
      RELAY_SECRET_KEYS: TEST_KEYRING_TEXT,
      RELAY_COOKIE_SECURE: "false",
      RELAY_VALKEY_URL: inject("valkeyUrl"),
    }),
    ...overrides,
  };
}

/** Public resolution for every host unless a test says otherwise. */
export const publicDns = async (_host: string) => ["93.184.215.14"];

const limiters: LoginLimiter[] = [];

/** A login limiter on the test Valkey with its own key prefix, so tests never share counts. */
export function testLimiter(limits: Partial<LoginLimits> = {}, url = inject("valkeyUrl")): LoginLimiter {
  const l = valkeyLoginLimiter(url, { ...testConfig().login, ...limits }, `relay:test:${randomUUID()}`);
  limiters.push(l);
  return l;
}

/** A fresh invite code, made the way the operator makes one. */
export const invite = (days = 7) => createInvite(dsn("relay_owner"), days, "test");

export async function makeApp(overrides: Partial<Deps> = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    config: testConfig(),
    db: appPool,
    keyring,
    resolve: publicDns,
    loginLimiter: overrides.loginLimiter ?? testLimiter(),
    ...overrides,
  });
  await app.ready();
  return app;
}

export function cleanDatabase() {
  beforeEach(async () => {
    await su.query(
      "TRUNCATE control.sessions, control.users, control.usage_daily, control.billing_accounts, control.stripe_events, " +
        "delivery.outbox, delivery.delivery_attempts, delivery.deliveries, delivery.idempotency_keys, delivery.dispatch_locks, " +
        "delivery.events, control.subscriptions, control.event_types, control.api_keys, control.endpoints, " +
        "control.transformations, control.invite_codes, control.tenants CASCADE",
    );
  });
  afterAll(async () => {
    for (const l of limiters) await l.close();
    await appPool.end().catch(() => {});
    await su.end().catch(() => {});
  });
}

export interface Account {
  token: string;
  cookie: string;
  tenantId: string;
  userId: string;
  email: string;
}

export function refreshCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
  const m = /relay_refresh=([^;]+)/.exec(header);
  if (!m) throw new Error(`no refresh cookie in ${header}`);
  return `relay_refresh=${m[1]}`;
}

export async function signup(
  app: FastifyInstance,
  email = `${randomUUID().slice(0, 8)}@example.com`,
): Promise<Account> {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { invite_code: await invite(), tenant_name: "Acme", email, password: "correct horse battery" },
  });
  if (r.statusCode !== 201) throw new Error(`register failed: ${r.statusCode} ${r.body}`);
  const body = r.json();
  return {
    token: body.access_token,
    cookie: refreshCookie(r.headers["set-cookie"]),
    tenantId: body.user.tenant_id,
    userId: body.user.id,
    email,
  };
}

export const bearer = (a: Account) => ({ authorization: `Bearer ${a.token}` });

/** Add a user with a role to an account's tenant and return their access token. */
export async function member(
  app: FastifyInstance,
  owner: Account,
  role: "admin" | "viewer",
): Promise<Account> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: bearer(owner),
    payload: { email, password: "another long password", role },
  });
  if (created.statusCode !== 201) throw new Error(`add user failed: ${created.body}`);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: "another long password" },
  });
  const body = login.json();
  return {
    token: body.access_token,
    cookie: refreshCookie(login.headers["set-cookie"]),
    tenantId: body.user.tenant_id,
    userId: body.user.id,
    email,
  };
}
