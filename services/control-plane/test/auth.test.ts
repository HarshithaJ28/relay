import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { bearer, cleanDatabase, invite, makeApp, refreshCookie, signup, su, testConfig } from "./helpers.js";

cleanDatabase();

describe("registration and login", () => {
  it("registers a tenant with its owner and starts a session", async () => {
    const app = await makeApp();
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        invite_code: await invite(),
        tenant_name: "Acme",
        email: "Owner@Example.com",
        password: "correct horse battery",
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.user).toMatchObject({ email: "owner@example.com", role: "owner" });
    expect(body.token_type).toBe("Bearer");
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const stored = await su.query(
      "SELECT password_hash FROM control.users WHERE email = 'owner@example.com'",
    );
    expect(stored.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0].password_hash).not.toContain("correct horse");
    const plan = await su.query("SELECT plan_id, retention_days FROM control.tenants WHERE id = $1", [
      body.user.tenant_id,
    ]);
    expect(plan.rows[0]).toEqual({ plan_id: "free", retention_days: 7 });
  });

  it("refuses a taken email and a weak password", async () => {
    const app = await makeApp();
    await signup(app, "taken@example.com");
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        invite_code: await invite(),
        tenant_name: "Other",
        email: "TAKEN@example.com",
        password: "correct horse battery",
      },
    });
    expect(again.statusCode).toBe(409);
    expect(again.headers["content-type"]).toMatch(/application\/problem\+json/);
    const weak = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        invite_code: await invite(),
        tenant_name: "Other",
        email: "new@example.com",
        password: "short",
      },
    });
    expect(weak.statusCode).toBe(422);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const app = await makeApp();
    await signup(app, "known@example.com");
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "known@example.com", password: "not the password" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "not the password" },
    });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(unknown.json());
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "known@example.com", password: "correct horse battery" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("sessions", () => {
  it("rotates the refresh token on every use", async () => {
    const app = await makeApp();
    const account = await signup(app);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: account.cookie },
    });
    expect(r.statusCode).toBe(200);
    const next = refreshCookie(r.headers["set-cookie"]);
    expect(next).not.toBe(account.cookie);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/me",
          headers: { authorization: `Bearer ${r.json().access_token}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("revokes the whole session family when an old refresh token is reused", async () => {
    const app = await makeApp();
    const account = await signup(app);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: account.cookie },
    });
    const current = refreshCookie(first.headers["set-cookie"]);
    // A stolen copy of the original token is replayed:
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: account.cookie },
    });
    expect(replay.statusCode).toBe(401);
    // and the legitimate, newer token no longer works either.
    const legit = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: current },
    });
    expect(legit.statusCode).toBe(401);
  });

  it("logout ends the session", async () => {
    const app = await makeApp();
    const account = await signup(app);
    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: account.cookie },
    });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: { cookie: account.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("refuses missing, tampered, expired and wrongly signed access tokens", async () => {
    const app = await makeApp();
    const account = await signup(app);
    const secret = testConfig().jwtSecret;
    const expired = await new SignJWT({ tid: account.tenantId, role: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(account.userId)
      .setIssuer("relay")
      .setAudience("relay-console")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);
    const otherKey = await new SignJWT({ tid: account.tenantId, role: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(account.userId)
      .setIssuer("relay")
      .setAudience("relay-console")
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("a-different-secret-a-different-secret!!"));
    const otherAudience = await new SignJWT({ tid: account.tenantId, role: "owner" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(account.userId)
      .setIssuer("relay")
      .setAudience("some-other-service") // same key, minted for a different service
      .setExpirationTime("10m")
      .sign(secret);
    const [head, body, sig] = account.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body as string, "base64url").toString()),
        role: "owner",
        tid: "00000000-0000-0000-0000-000000000000",
      }),
    ).toString("base64url");
    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: `Bearer ${expired}` },
      { authorization: `Bearer ${otherKey}` },
      { authorization: `Bearer ${otherAudience}` },
      { authorization: `Bearer ${head}.${forged}.${sig}` },
      { authorization: `Basic ${account.token}` },
    ]) {
      const r = await app.inject({ method: "GET", url: "/api/v1/me", headers });
      expect(r.statusCode, JSON.stringify(headers).slice(0, 40)).toBe(401);
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/me", headers: bearer(account) })).statusCode,
    ).toBe(200);
  });
});
