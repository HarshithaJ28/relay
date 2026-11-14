import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Valkey } from "iovalkey";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";
import { sha256 } from "../src/apiKeys.js";
import { createInvite } from "../src/cli.js";
import { toConnectionString } from "../src/db.js";
import { cleanDatabase, dsn, invite, makeApp, signup, su, testConfig, testLimiter } from "./helpers.js";

cleanDatabase();

const PASSWORD = "correct horse battery";

function register(
  app: FastifyInstance,
  inviteCode: string,
  email = `${randomUUID().slice(0, 8)}@example.com`,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { invite_code: inviteCode, tenant_name: "Acme", email, password: PASSWORD },
  });
}

function login(app: FastifyInstance, email: string, password: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, ...extra });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("invite-only registration", () => {
  it("refuses registration with no code, a malformed code or an unknown code", async () => {
    const app = await makeApp();
    const none = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { tenant_name: "Acme", email: "a@example.com", password: PASSWORD },
    });
    expect(none.statusCode).toBe(422);
    const malformed = await register(app, "let-me-in");
    expect(malformed.statusCode).toBe(403);
    expect(malformed.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(malformed.json().type).toBe("/problems/invalid-invite");
    const unknown = await register(app, `rinv_${"A".repeat(43)}`);
    expect(unknown.statusCode).toBe(403);
    const tenants = await su.query("SELECT count(*)::int AS n FROM control.tenants");
    expect(tenants.rows[0].n).toBe(0);
  });

  it("uses a code once, and records which tenant used it", async () => {
    const app = await makeApp();
    const code = await invite();
    const first = await register(app, code);
    expect(first.statusCode).toBe(201);
    const second = await register(app, code);
    expect(second.statusCode).toBe(403);
    const row = await su.query("SELECT used_at, used_by_tenant FROM control.invite_codes");
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].used_at).not.toBeNull();
    expect(row.rows[0].used_by_tenant).toBe(first.json().user.tenant_id);
  });

  it("refuses an expired code", async () => {
    const app = await makeApp();
    const code = await invite();
    await su.query(
      "UPDATE control.invite_codes SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'",
    );
    expect((await register(app, code)).statusCode).toBe(403);
  });

  it("leaves the code unused when the email is taken", async () => {
    const app = await makeApp();
    await signup(app, "taken@example.com");
    const code = await invite();
    expect((await register(app, code, "taken@example.com")).statusCode).toBe(409);
    expect((await register(app, code, "fresh@example.com")).statusCode).toBe(201);
  });

  it("lets exactly one of two simultaneous registrations use a code", async () => {
    const app = await makeApp();
    const code = await invite();
    const results = await Promise.all([register(app, code), register(app, code), register(app, code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403, 403]);
    const tenants = await su.query("SELECT count(*)::int AS n FROM control.tenants");
    expect(tenants.rows[0].n).toBe(1);
  });

  it("stores only the hash, and only the operator role can make codes", async () => {
    const code = await createInvite(dsn("relay_owner"), 7, "for a reviewer");
    const stored = await su.query("SELECT * FROM control.invite_codes");
    expect(stored.rows).toHaveLength(1);
    expect(Buffer.from(stored.rows[0].code_hash)).toEqual(sha256(code));
    expect(JSON.stringify(stored.rows[0])).not.toContain(code.slice(5));
    const api = new pg.Client({ connectionString: toConnectionString(dsn("relay_control")) });
    await api.connect();
    try {
      await expect(
        api.query("SELECT control.create_invite($1, interval '1 day', '')", [sha256("rinv_x")]),
      ).rejects.toMatchObject({ code: "42501" });
      // the old path that skipped the invite is closed to the API
      await expect(
        api.query("SELECT * FROM control.register_tenant('x', 'x@example.com', 'h')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(api.query("SELECT 1 FROM control.invite_codes")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await api.end();
    }
    await expect(createInvite(dsn("relay_owner"), 31, "")).rejects.toMatchObject({ code: "22023" });
    await expect(createInvite(dsn("relay_owner"), 0, "")).rejects.toMatchObject({ code: "22023" });
  });
});

describe("login throttling", () => {
  it("locks an account after repeated failures, even for the right password, then unlocks", async () => {
    const app = await makeApp({
      loginLimiter: testLimiter({ maxPerAccount: 3, maxPerIp: 100, lockSeconds: 2 }),
    });
    const a = await signup(app);
    for (let i = 0; i < 3; i++) expect((await login(app, a.email, "wrong password")).statusCode).toBe(401);
    const locked = await login(app, a.email, PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(locked.json().type).toBe("/problems/too-many-attempts");
    const retry = Number(locked.headers["retry-after"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(2);
    expect(locked.headers["set-cookie"]).toBeUndefined();
    // another account from the same IP is not affected
    const b = await signup(app);
    expect((await login(app, b.email, PASSWORD)).statusCode).toBe(200);
    await sleep(2100);
    expect((await login(app, a.email, PASSWORD)).statusCode).toBe(200);
  });

  it("clears an account's failure count when it logs in", async () => {
    const app = await makeApp({ loginLimiter: testLimiter({ maxPerAccount: 3, maxPerIp: 100 }) });
    const a = await signup(app);
    for (let i = 0; i < 2; i++) expect((await login(app, a.email, "wrong password")).statusCode).toBe(401);
    expect((await login(app, a.email, PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) expect((await login(app, a.email, "wrong password")).statusCode).toBe(401);
    expect((await login(app, a.email, PASSWORD)).statusCode).toBe(200);
  });

  it("locks an unknown email the same way, so the lock reveals nothing", async () => {
    const app = await makeApp({ loginLimiter: testLimiter({ maxPerAccount: 3, maxPerIp: 100 }) });
    for (let i = 0; i < 3; i++)
      expect((await login(app, "nobody@example.com", "wrong password")).statusCode).toBe(401);
    expect((await login(app, "nobody@example.com", "wrong password")).statusCode).toBe(429);
  });

  it("locks an IP that fails across many accounts, and only that IP", async () => {
    const app = await makeApp({ loginLimiter: testLimiter({ maxPerAccount: 100, maxPerIp: 3 }) });
    const a = await signup(app);
    const from = (ip: string) => ({ remoteAddress: ip });
    for (let i = 0; i < 3; i++)
      expect(
        (await login(app, `guess${i}@example.com`, "wrong password", from("203.0.113.7"))).statusCode,
      ).toBe(401);
    expect((await login(app, a.email, PASSWORD, from("203.0.113.7"))).statusCode).toBe(429);
    expect((await login(app, a.email, PASSWORD, from("203.0.113.8"))).statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For unless proxy hops are configured", async () => {
    const limits = { maxPerAccount: 100, maxPerIp: 2 };
    const direct = await makeApp({ loginLimiter: testLimiter(limits) });
    for (let i = 0; i < 2; i++)
      await login(direct, `g${i}@example.com`, "wrong", {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
    const spoofed = await login(direct, "g9@example.com", "wrong", {
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(spoofed.statusCode).toBe(429); // a made-up header does not give a fresh IP

    const proxied = await makeApp({
      config: testConfig({ trustedProxyHops: 1 }),
      loginLimiter: testLimiter(limits),
    });
    for (let i = 0; i < 2; i++)
      await login(proxied, `p${i}@example.com`, "wrong", { headers: { "x-forwarded-for": "198.51.100.1" } });
    const other = await login(proxied, "p9@example.com", "wrong", {
      headers: { "x-forwarded-for": "198.51.100.2" },
    });
    expect(other.statusCode).toBe(401); // behind the configured proxy, each client is counted alone
  });

  it("refuses logins with 503 when Valkey is unreachable", async () => {
    const live = await makeApp();
    const a = await signup(live);
    const app = await makeApp({ loginLimiter: testLimiter({}, "redis://127.0.0.1:1/0") });
    const r = await login(app, a.email, PASSWORD);
    expect(r.statusCode).toBe(503);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("keeps no email address in Valkey", async () => {
    const app = await makeApp({ loginLimiter: testLimiter({ maxPerAccount: 2 }) });
    for (let i = 0; i < 2; i++) await login(app, "private.person@example.com", "wrong");
    const v = new Valkey(inject("valkeyUrl"));
    try {
      const keys = await v.keys("relay:test:*");
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.join(" ")).not.toMatch(/@|private\.person/);
    } finally {
      v.disconnect();
    }
  });
});
