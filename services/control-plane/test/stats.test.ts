import { randomUUID } from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { successRate } from "../src/routes/stats.js";
import { valkeyJsonCache } from "../src/statsCache.js";
import { type Account, bearer, cleanDatabase, makeApp, signup, su } from "./helpers.js";

cleanDatabase();

type App = Awaited<ReturnType<typeof makeApp>>;
const T0 = "2026-03-02T00:00:00.000Z"; // a Monday, UTC
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();
const cache = (ttl = 30) => valkeyJsonCache(inject("valkeyUrl"), ttl, `relay:test-stats:${randomUUID()}`);

/** One event and one delivery per status at the given time (via the test-event route), with an
 * attempt for each finished one; then moved to `when`. */
async function seed(app: App, a: Account, when: string, statuses: string[]) {
  const e = (
    await app.inject({
      method: "POST",
      url: "/api/v1/endpoints",
      headers: bearer(a),
      payload: { url: "https://h.example.com/" },
    })
  ).json();
  for (const status of statuses) {
    const t = (
      await app.inject({ method: "POST", url: `/api/v1/endpoints/${e.id}/test`, headers: bearer(a) })
    ).json();
    const d = (await su.query("SELECT event_id FROM delivery.deliveries WHERE id = $1", [t.delivery_id]))
      .rows[0];
    await su.query("UPDATE delivery.events SET created_at = $2 WHERE id = $1", [d.event_id, when]);
    await su.query(
      "UPDATE delivery.deliveries SET status = $2, created_at = $3, event_created_at = $3 WHERE id = $1",
      [t.delivery_id, status, when],
    );
    if (status === "succeeded" || status === "dead") {
      await su.query(
        "INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, created_at) VALUES ($1, 1, true, $2, $3)",
        [t.delivery_id, status === "succeeded" ? "success" : "dead", when],
      );
    }
  }
}

function stats(app: App, a: Account, from: string, to: string, bucket?: "hour" | "day") {
  const q = new URLSearchParams({ from, to, ...(bucket ? { bucket } : {}) });
  return app.inject({ method: "GET", url: `/api/v1/stats?${q}`, headers: bearer(a) });
}

describe("stats: range limits", () => {
  it("accepts up to 31 days, and refuses longer, empty or reversed ranges with a problem", async () => {
    const app = await makeApp();
    const a = await signup(app);
    expect((await stats(app, a, T0, at(31 * 24))).statusCode).toBe(200);
    for (const [from, to] of [
      [T0, at(31 * 24 + 1)],
      [T0, T0],
      [at(5), T0],
    ] as const) {
      const r = await stats(app, a, from, to);
      expect(r.statusCode).toBe(422);
      expect(r.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(r.json().type).toBe("/problems/invalid-range");
    }
    expect((await app.inject({ method: "GET", url: "/api/v1/stats", headers: bearer(a) })).statusCode).toBe(
      422,
    );
  });

  it("allows hourly buckets up to 7 days only", async () => {
    const app = await makeApp();
    const a = await signup(app);
    expect((await stats(app, a, T0, at(7 * 24), "hour")).statusCode).toBe(200);
    const r = await stats(app, a, T0, at(7 * 24 + 1), "hour");
    expect(r.statusCode).toBe(422);
    expect(r.json().detail).toMatch(/bucket=day/);
    expect((await stats(app, a, T0, at(7 * 24 + 1), "day")).statusCode).toBe(200);
  });

  it("needs a token", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/stats?from=${T0}&to=${at(1)}` })).statusCode,
    ).toBe(401);
  });
});

describe("stats: buckets", () => {
  it("returns one bucket per UTC hour or day, rounding the range out to whole buckets, zeros included", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const hourly = (await stats(app, a, at(0.5), at(3.25), "hour")).json();
    expect(hourly.buckets.map((b: { start: string }) => b.start)).toEqual([at(0), at(1), at(2), at(3)]);
    expect(hourly.from).toBe(at(0));
    expect(hourly.to).toBe(at(4));
    expect(hourly.buckets[0]).toMatchObject({ events: 0, attempts: 0, success_rate: null });
    const daily = (await stats(app, a, at(1), at(49))).json();
    expect(daily.bucket).toBe("day");
    expect(daily.buckets.map((b: { start: string }) => b.start)).toEqual([at(0), at(24), at(48)]);
  });

  it("counts events, attempts and deliveries by status into the right bucket", async () => {
    const app = await makeApp();
    const a = await signup(app);
    await seed(app, a, at(1.5), ["succeeded", "succeeded", "succeeded", "dead"]);
    await seed(app, a, at(2.5), ["scheduled", "cancelled"]);
    // a deferral is recorded as an attempt that is not counted: it must not appear in attempts
    await su.query(
      "INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, created_at) " +
        "SELECT id, 2, false, 'deferred', $1 FROM delivery.deliveries WHERE status = 'succeeded' LIMIT 1",
      [at(1.5)],
    );
    const s = (await stats(app, a, T0, at(4), "hour")).json();
    const b1 = s.buckets[1];
    expect(b1).toMatchObject({ start: at(1), events: 4, attempts: 4 });
    expect(b1.deliveries).toMatchObject({ succeeded: 3, dead: 1, scheduled: 0 });
    expect(s.buckets[2].deliveries).toMatchObject({ scheduled: 1, cancelled: 1 });
    expect(s.totals).toMatchObject({ events: 6, attempts: 4 });
    expect(s.totals.deliveries).toEqual({
      scheduled: 1,
      queued: 0,
      in_flight: 0,
      succeeded: 3,
      dead: 1,
      cancelled: 1,
    });
  });
});

describe("stats: success rate", () => {
  it("is succeeded / (succeeded + dead + cancelled), and null when nothing finished", () => {
    expect(successRate({ succeeded: 3, dead: 1 })).toBe(0.75);
    expect(successRate({ succeeded: 1, cancelled: 1 })).toBe(0.5);
    expect(successRate({ succeeded: 0, dead: 2 })).toBe(0);
    expect(successRate({ scheduled: 4, queued: 2, in_flight: 1 })).toBeNull();
    expect(successRate({})).toBeNull();
  });

  it("is computed per bucket and overall from real rows", async () => {
    const app = await makeApp();
    const a = await signup(app);
    await seed(app, a, at(0.5), ["succeeded", "succeeded", "succeeded", "dead"]);
    await seed(app, a, at(1.5), ["scheduled", "scheduled"]);
    await seed(app, a, at(2.5), ["dead"]);
    const s = (await stats(app, a, T0, at(3), "hour")).json();
    expect(s.buckets.map((b: { success_rate: number | null }) => b.success_rate)).toEqual([0.75, null, 0]);
    expect(s.totals.success_rate).toBe(0.6);
  });
});

describe("stats: cache", () => {
  it("answers a repeated request from the cache until it expires", async () => {
    const app = await makeApp({ statsCache: cache(1) });
    const a = await signup(app);
    await seed(app, a, at(0.5), ["succeeded"]);
    const first = await stats(app, a, T0, at(1), "hour");
    expect(first.headers["x-relay-cache"]).toBe("miss");
    await seed(app, a, at(0.5), ["dead"]);
    const second = await stats(app, a, T0, at(1), "hour");
    expect(second.headers["x-relay-cache"]).toBe("hit");
    expect(second.json()).toEqual(first.json()); // the new delivery is not visible yet
    await new Promise((r) => setTimeout(r, 1300));
    const third = await stats(app, a, T0, at(1), "hour");
    expect(third.headers["x-relay-cache"]).toBe("miss");
    expect(third.json().totals.deliveries).toMatchObject({ succeeded: 1, dead: 1 });
  });

  it("keeps working, uncached, when Valkey is unreachable", async () => {
    const app = await makeApp({ statsCache: valkeyJsonCache("redis://127.0.0.1:1/0") });
    const a = await signup(app);
    expect((await stats(app, a, T0, at(1), "hour")).statusCode).toBe(200);
  });
});

describe("stats: tenant isolation", () => {
  it("counts only the caller's tenant, also when the same request is cached for another tenant", async () => {
    const app = await makeApp({ statsCache: cache() });
    const a = await signup(app);
    const b = await signup(app);
    await seed(app, a, at(0.5), ["succeeded", "succeeded"]);
    await seed(app, b, at(0.5), ["dead"]);
    const sa = (await stats(app, a, T0, at(1), "hour")).json();
    const rb = await stats(app, b, T0, at(1), "hour");
    expect(rb.headers["x-relay-cache"]).toBe("miss");
    expect(sa.totals).toMatchObject({ events: 2, deliveries: { succeeded: 2, dead: 0 } });
    expect(rb.json().totals).toMatchObject({ events: 1, deliveries: { succeeded: 0, dead: 1 } });
  });
});
