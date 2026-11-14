import { describe, expect, it } from "vitest";
import { type Account, bearer, cleanDatabase, keyring, makeApp, member, signup, su } from "./helpers.js";

cleanDatabase();

async function endpoint(
  app: Awaited<ReturnType<typeof makeApp>>,
  a: Account,
  url = "https://hooks.example.com/relay",
) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/endpoints",
    headers: bearer(a),
    payload: { url },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json();
}

describe("endpoints", () => {
  it("creates an endpoint with an encrypted signing secret shown once", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const created = await endpoint(app, a);
    expect(created.signing_secret).toMatch(/^whsec_/);
    expect(created.signing_secrets).toEqual([{ kid: "s1", expires_at: null }]);
    const stored = await su.query("SELECT signing_secrets FROM control.endpoints WHERE id = $1", [
      created.id,
    ]);
    const [entry] = stored.rows[0].signing_secrets;
    expect(JSON.stringify(stored.rows[0])).not.toContain(created.signing_secret);
    expect(keyring.decrypt(created.id, entry)).toBe(created.signing_secret);
    const listed = await app.inject({ method: "GET", url: "/api/v1/endpoints", headers: bearer(a) });
    expect(JSON.stringify(listed.json())).not.toContain("whsec_");
  });

  it("refuses URLs the delivery path would refuse, including by what the name resolves to", async () => {
    const app = await makeApp({
      resolve: async (host) => (host === "internal.example.com" ? ["10.1.2.3"] : ["93.184.215.14"]),
    });
    const a = await signup(app);
    for (const url of [
      "http://hooks.example.com/",
      "https://127.0.0.1/",
      "https://169.254.169.254/",
      "https://internal.example.com/",
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/v1/endpoints",
        headers: bearer(a),
        payload: { url },
      });
      expect(r.statusCode, url).toBe(422);
      expect(r.json().type).toBe("/problems/blocked-destination");
    }
    const id = (await endpoint(app, a)).id;
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/endpoints/${id}`,
      headers: bearer(a),
      payload: { url: "https://internal.example.com/" },
    });
    expect(patch.statusCode).toBe(422);
  });

  it("enforces the plan's endpoint limit", async () => {
    const app = await makeApp();
    const a = await signup(app); // free plan: 3 endpoints
    for (let i = 0; i < 3; i++) await endpoint(app, a);
    const fourth = await app.inject({
      method: "POST",
      url: "/api/v1/endpoints",
      headers: bearer(a),
      payload: { url: "https://x.example.com/" },
    });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().type).toBe("/problems/plan-limit");
  });

  it("rotates a secret with an overlap so receivers can switch without downtime", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const e = await endpoint(app, a);
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/endpoints/${e.id}/rotate-secret`,
      headers: bearer(a),
      payload: { overlap_hours: 24 },
    });
    expect(r.statusCode).toBe(200);
    const rotated = r.json();
    expect(rotated.signing_secrets).toHaveLength(2);
    const [old, fresh] = rotated.signing_secrets;
    expect(old.kid).toBe("s1");
    expect(new Date(old.expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(fresh.expires_at).toBeNull();
    const revealed = await app.inject({
      method: "GET",
      url: `/api/v1/endpoints/${e.id}/secret`,
      headers: bearer(a),
    });
    expect(revealed.json().secrets.map((s: { secret: string }) => s.secret)).toEqual([
      e.signing_secret,
      rotated.signing_secret,
    ]);
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/endpoints/${e.id}/rotate-secret`,
      headers: bearer(a),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it("deleting keeps history: the endpoint is disabled and unsubscribed", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const e = await endpoint(app, a);
    await app.inject({
      method: "POST",
      url: "/api/v1/event-types",
      headers: bearer(a),
      payload: { name: "order.created" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/subscriptions",
      headers: bearer(a),
      payload: { endpoint_id: e.id, event_type: "order.created" },
    });
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/endpoints/${e.id}`, headers: bearer(a) }))
        .statusCode,
    ).toBe(204);
    const after = await app.inject({ method: "GET", url: `/api/v1/endpoints/${e.id}`, headers: bearer(a) });
    expect(after.json().status).toBe("disabled");
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/subscriptions", headers: bearer(a) })).json(),
    ).toEqual([]);
  });

  it("a test event becomes a delivery to that endpoint only, and health reports on it", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const e = await endpoint(app, a);
    const other = await endpoint(app, a, "https://other.example.com/");
    const r = await app.inject({ method: "POST", url: `/api/v1/endpoints/${e.id}/test`, headers: bearer(a) });
    expect(r.statusCode).toBe(202);
    const rows = await su.query("SELECT endpoint_id, status FROM delivery.deliveries WHERE event_id = $1", [
      r.json().event_id,
    ]);
    expect(rows.rows).toEqual([{ endpoint_id: e.id, status: "scheduled" }]);
    const health = await app.inject({
      method: "GET",
      url: `/api/v1/endpoints/${e.id}/health`,
      headers: bearer(a),
    });
    expect(health.json()).toMatchObject({ active_deliveries: 1, attempts: 0, breaker: { state: "closed" } });
    expect(
      (
        await app.inject({ method: "GET", url: `/api/v1/endpoints/${other.id}/health`, headers: bearer(a) })
      ).json().active_deliveries,
    ).toBe(0);
  });
});

describe("API keys", () => {
  it("are shown once, stored as a hash, listed by prefix and revocable", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: bearer(a),
      payload: { name: "ci" },
    });
    expect(r.statusCode).toBe(201);
    const { id, key, prefix } = r.json();
    const stored = await su.query("SELECT key_hash, prefix FROM control.api_keys WHERE id = $1", [id]);
    expect(stored.rows[0].prefix).toBe(prefix);
    expect(Buffer.from(stored.rows[0].key_hash).toString("hex")).not.toContain(key);
    const listed = await app.inject({ method: "GET", url: "/api/v1/api-keys", headers: bearer(a) });
    expect(JSON.stringify(listed.json())).not.toContain(key);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/api-keys/${id}`, headers: bearer(a) })).statusCode,
    ).toBe(204);
    const revoked = await su.query("SELECT revoked_at FROM control.api_keys WHERE id = $1", [id]);
    expect(revoked.rows[0].revoked_at).not.toBeNull();
  });
});

describe("roles", () => {
  it("viewers read, admins manage endpoints, only owners manage keys, users and billing", async () => {
    const app = await makeApp();
    const owner = await signup(app);
    const admin = await member(app, owner, "admin");
    const viewer = await member(app, owner, "viewer");
    const post = (a: Account, url: string, payload: object) =>
      app.inject({ method: "POST", url, headers: bearer(a), payload });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/endpoints", headers: bearer(viewer) })).statusCode,
    ).toBe(200);
    expect((await post(viewer, "/api/v1/endpoints", { url: "https://a.example.com/" })).statusCode).toBe(403);
    expect((await post(admin, "/api/v1/endpoints", { url: "https://a.example.com/" })).statusCode).toBe(201);
    expect((await post(admin, "/api/v1/api-keys", {})).statusCode).toBe(403);
    expect(
      (
        await post(admin, "/api/v1/users", {
          email: "x@example.com",
          password: "long enough password",
          role: "viewer",
        })
      ).statusCode,
    ).toBe(403);
    expect((await post(owner, "/api/v1/api-keys", {})).statusCode).toBe(201);
  });
});

describe("tenant isolation (spec section 7: every route called with another tenant's ids)", () => {
  it("never reveals or changes another tenant's resources", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const b = await signup(app);
    const e = await endpoint(app, a);
    await app.inject({
      method: "POST",
      url: "/api/v1/event-types",
      headers: bearer(a),
      payload: { name: "order.created" },
    });
    const sub = (
      await app.inject({
        method: "POST",
        url: "/api/v1/subscriptions",
        headers: bearer(a),
        payload: { endpoint_id: e.id, event_type: "order.created" },
      })
    ).json();
    const key = (
      await app.inject({ method: "POST", url: "/api/v1/api-keys", headers: bearer(a), payload: {} })
    ).json();
    const test = (
      await app.inject({ method: "POST", url: `/api/v1/endpoints/${e.id}/test`, headers: bearer(a) })
    ).json();
    await su.query("UPDATE delivery.deliveries SET status = 'dead' WHERE id = $1", [test.delivery_id]);

    const attacks: [string, string, object?][] = [
      ["GET", `/api/v1/endpoints/${e.id}`],
      ["PATCH", `/api/v1/endpoints/${e.id}`, { status: "disabled" }],
      ["DELETE", `/api/v1/endpoints/${e.id}`],
      ["POST", `/api/v1/endpoints/${e.id}/rotate-secret`, {}],
      ["GET", `/api/v1/endpoints/${e.id}/secret`],
      ["POST", `/api/v1/endpoints/${e.id}/test`],
      ["GET", `/api/v1/endpoints/${e.id}/health`],
      ["POST", "/api/v1/subscriptions", { endpoint_id: e.id, event_type: "order.created" }],
      ["DELETE", `/api/v1/subscriptions/${sub.id}`],
      ["DELETE", `/api/v1/api-keys/${key.id}`],
      ["GET", `/api/v1/deliveries/${test.delivery_id}`],
      ["POST", `/api/v1/deliveries/${test.delivery_id}/replay`, {}],
      ["DELETE", `/api/v1/users/${a.userId}`],
    ];
    for (const [method, url, payload] of attacks) {
      const r = await app.inject({
        method: method as "GET",
        url,
        headers: bearer(b),
        ...(payload ? { payload } : {}),
      });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    const users = (await app.inject({ method: "GET", url: "/api/v1/users", headers: bearer(b) })).json();
    expect(users.map((u: { email: string }) => u.email)).toEqual([b.email]); // only B's own owner
    for (const url of [
      "/api/v1/endpoints",
      "/api/v1/subscriptions",
      "/api/v1/api-keys",
      "/api/v1/deliveries",
      "/api/v1/event-types",
    ]) {
      const r = await app.inject({ method: "GET", url, headers: bearer(b) });
      const body = r.json();
      expect(Array.isArray(body) ? body : body.data, url).toEqual([]);
    }
    // and nothing of A's changed
    const still = await su.query("SELECT status FROM control.endpoints WHERE id = $1", [e.id]);
    expect(still.rows[0].status).toBe("enabled");
    expect((await su.query("SELECT count(*)::int AS n FROM control.subscriptions")).rows[0].n).toBe(1);
  });
});
