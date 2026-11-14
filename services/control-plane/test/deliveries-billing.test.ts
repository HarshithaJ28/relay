import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { type Account, bearer, cleanDatabase, makeApp, signup, su, testConfig } from "./helpers.js";

cleanDatabase();

type App = Awaited<ReturnType<typeof makeApp>>;

/** n deliveries to a new endpoint, finished with the given statuses, via the test-event route. */
async function finished(app: App, a: Account, statuses: string[]) {
  const e = (
    await app.inject({
      method: "POST",
      url: "/api/v1/endpoints",
      headers: bearer(a),
      payload: { url: "https://h.example.com/" },
    })
  ).json();
  const ids: string[] = [];
  for (const status of statuses) {
    const t = (
      await app.inject({ method: "POST", url: `/api/v1/endpoints/${e.id}/test`, headers: bearer(a) })
    ).json();
    await su.query("UPDATE delivery.deliveries SET status = $2 WHERE id = $1", [t.delivery_id, status]);
    if (status !== "scheduled") {
      await su.query(
        "INSERT INTO delivery.delivery_attempts (delivery_id, attempt_no, counted, outcome, status_code, error_class) VALUES ($1, 1, true, $2, $3, $4)",
        [
          t.delivery_id,
          status === "succeeded" ? "success" : "dead",
          status === "succeeded" ? 200 : 503,
          status === "succeeded" ? null : "http_5xx",
        ],
      );
    }
    ids.push(t.delivery_id);
  }
  return { endpointId: e.id as string, ids };
}

async function expire(id: string) {
  const row = await su.query("SELECT event_id FROM delivery.deliveries WHERE id = $1", [id]);
  const ts = (await su.query("SELECT now() - interval '40 days' AS ts")).rows[0].ts;
  await su.query("UPDATE delivery.events SET created_at = $2 WHERE id = $1", [row.rows[0].event_id, ts]);
  await su.query("UPDATE delivery.deliveries SET event_created_at = $2 WHERE event_id = $1", [
    row.rows[0].event_id,
    ts,
  ]);
}

describe("deliveries", () => {
  it("lists with filters and cursor pagination, newest first", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids, endpointId } = await finished(app, a, ["succeeded", "dead", "dead", "succeeded", "dead"]);
    const dead = await app.inject({
      method: "GET",
      url: "/api/v1/deliveries?status=dead",
      headers: bearer(a),
    });
    expect(dead.json().data).toHaveLength(3);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/deliveries?endpoint_id=${endpointId}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        headers: bearer(a),
      });
      const body = r.json();
      seen.push(...body.data.map((d: { id: string }) => d.id));
      cursor = body.next_cursor;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/deliveries?cursor=garbage", headers: bearer(a) }))
        .statusCode,
    ).toBe(422);
  });

  it("pagination never skips rows created in the same millisecond", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids } = await finished(app, a, ["dead"]);
    const row = (await su.query("SELECT * FROM delivery.deliveries WHERE id = $1", [ids[0]])).rows[0];
    // five more deliveries with one created_at, differing only in microseconds
    await su.query(
      "INSERT INTO delivery.deliveries (tenant_id, endpoint_id, event_id, event_created_at, created_at) " +
        "SELECT $1, $2, $3, $4, date_trunc('milliseconds', now()) + make_interval(secs => g / 1000000.0) FROM generate_series(1, 5) g",
      [row.tenant_id, row.endpoint_id, row.event_id, row.event_created_at],
    );
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const r = await app.inject({
        method: "GET",
        url: `/api/v1/deliveries?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        headers: bearer(a),
      });
      for (const d of r.json().data) seen.add(d.id);
      cursor = r.json().next_cursor;
    } while (cursor);
    expect(seen.size).toBe(6);
  });

  it("shows a delivery with its attempts, and hides the payload once it has expired (AC-3)", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids } = await finished(app, a, ["dead"]);
    const live = (
      await app.inject({ method: "GET", url: `/api/v1/deliveries/${ids[0]}`, headers: bearer(a) })
    ).json();
    expect(live.attempts).toMatchObject([
      { attempt_no: 1, outcome: "dead", status_code: 503, error_class: "http_5xx" },
    ]);
    expect(live.event).toMatchObject({ event_type: "relay.test", payload_expired: false });
    expect(live.event.payload.message).toBe("Test event from Relay");
    await expire(ids[0] as string);
    const old = (
      await app.inject({ method: "GET", url: `/api/v1/deliveries/${ids[0]}`, headers: bearer(a) })
    ).json();
    expect(old.event).toMatchObject({ payload: null, payload_expired: true });
  });
});

describe("replay", () => {
  it("replays with the documented message-id defaults", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids } = await finished(app, a, ["succeeded", "dead"]);
    const [ok, dead] = ids as [string, string];
    const originals = await su.query("SELECT id, message_id FROM delivery.deliveries WHERE id = ANY($1)", [
      ids,
    ]);
    const messageOf = Object.fromEntries(originals.rows.map((r) => [r.id, r.message_id]));
    const r1 = (
      await app.inject({
        method: "POST",
        url: `/api/v1/deliveries/${ok}/replay`,
        headers: bearer(a),
        payload: {},
      })
    ).json();
    const r2 = (
      await app.inject({
        method: "POST",
        url: `/api/v1/deliveries/${dead}/replay`,
        headers: bearer(a),
        payload: {},
      })
    ).json();
    expect(r1).toMatchObject({ message_id_mode: "new", replay_of: ok });
    expect(r1.message_id).not.toBe(messageOf[ok]);
    expect(r2).toMatchObject({ message_id_mode: "reuse", message_id: messageOf[dead], replay_of: dead });
  });

  it("refuses active deliveries and answers 410 with the expiry once the payload is gone", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids } = await finished(app, a, ["scheduled", "dead"]);
    const active = await app.inject({
      method: "POST",
      url: `/api/v1/deliveries/${ids[0]}/replay`,
      headers: bearer(a),
      payload: {},
    });
    expect(active.statusCode).toBe(409);
    await expire(ids[1] as string);
    const gone = await app.inject({
      method: "POST",
      url: `/api/v1/deliveries/${ids[1]}/replay`,
      headers: bearer(a),
      payload: {},
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json()).toMatchObject({ type: "/problems/replay-unavailable", reason: "payload_expired" });
    expect(gone.json().expired_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("bulk replay reports counts first, then replays only what is replayable", async () => {
    const app = await makeApp();
    const a = await signup(app);
    const { ids } = await finished(app, a, ["dead", "dead", "dead", "succeeded"]);
    await expire(ids[2] as string);
    const preview = (
      await app.inject({
        method: "POST",
        url: "/api/v1/replays",
        headers: bearer(a),
        payload: { status: "dead" },
      })
    ).json();
    expect(preview).toEqual({ dry_run: true, replayable: 2, expired: 1, already_succeeded: 1, replayed: 0 });
    expect(
      (await su.query("SELECT count(*)::int AS n FROM delivery.deliveries WHERE replay_of IS NOT NULL"))
        .rows[0].n,
    ).toBe(0);
    const run = (
      await app.inject({
        method: "POST",
        url: "/api/v1/replays",
        headers: bearer(a),
        payload: { status: "dead", dry_run: false },
      })
    ).json();
    expect(run).toMatchObject({ dry_run: false, replayed: 2 });
    const replays = await su.query(
      "SELECT replay_of FROM delivery.deliveries WHERE replay_of IS NOT NULL ORDER BY replay_of",
    );
    expect(replays.rows.map((r) => r.replay_of).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("usage shows month-to-date events against the plan", async () => {
    const app = await makeApp();
    const a = await signup(app);
    await finished(app, a, ["succeeded", "dead"]);
    const usage = (await app.inject({ method: "GET", url: "/api/v1/usage", headers: bearer(a) })).json();
    expect(usage).toMatchObject({ plan: "free", month_to_date: { events: 2, limit: 10000 } });
  });
});

describe("billing (Stripe test mode)", () => {
  const webhookSecret = "whsec_test_relay_webhook_secret";
  const stripe = new Stripe("sk_test_unused");

  async function billingApp(created: object[] = []) {
    const fake = {
      webhooks: stripe.webhooks,
      checkout: {
        sessions: {
          create: async (params: object) => {
            created.push(params);
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      },
    } as unknown as Stripe;
    const config = testConfig();
    return makeApp({
      config: { ...config, stripe: { secretKey: "sk_test_unused", webhookSecret, pricePro: "price_pro" } },
      stripe: fake,
    });
  }

  function send(app: App, event: object, secret = webhookSecret) {
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload,
    });
  }

  const plan = async (tenantId: string) =>
    (
      await su.query(
        "SELECT plan_id, retention_days, ingest_rate_per_sec, dispatch_cap FROM control.tenants WHERE id = $1",
        [tenantId],
      )
    ).rows[0];

  it("creates a checkout session for the owner's tenant", async () => {
    const created: object[] = [];
    const app = await billingApp(created);
    const a = await signup(app);
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/billing/checkout-session",
      headers: bearer(a),
    });
    expect(r.json()).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(created[0]).toMatchObject({
      mode: "subscription",
      client_reference_id: a.tenantId,
      line_items: [{ price: "price_pro", quantity: 1 }],
    });
  });

  it("rejects an unsigned or wrongly signed webhook", async () => {
    const app = await billingApp();
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: {} } };
    expect((await send(app, event, "whsec_wrong")).statusCode).toBe(400);
    const unsigned = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(event),
    });
    expect(unsigned.statusCode).toBe(400);
  });

  it("upgrades on checkout, applies each event once, and downgrades on cancellation", async () => {
    const app = await billingApp();
    const a = await signup(app);
    const checkout = {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: a.tenantId,
          customer: "cus_1",
          subscription: "sub_1",
          payment_status: "paid",
          status: "complete",
        },
      },
    };
    expect((await send(app, checkout)).json()).toEqual({ received: true, applied: true });
    expect(await plan(a.tenantId)).toEqual({
      plan_id: "pro",
      retention_days: 30,
      ingest_rate_per_sec: 100,
      dispatch_cap: 100,
    });
    expect((await send(app, checkout)).json()).toEqual({ received: true, applied: false }); // Stripe retried: no double effect
    const cancelled = {
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } },
    };
    expect((await send(app, cancelled)).json().applied).toBe(true);
    expect(await plan(a.tenantId)).toEqual({
      plan_id: "free",
      retention_days: 7,
      ingest_rate_per_sec: 10,
      dispatch_cap: 20,
    });
  });

  it("answers 503 when billing is not configured", async () => {
    const app = await makeApp();
    const a = await signup(app);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/billing/checkout-session", headers: bearer(a) }))
        .statusCode,
    ).toBe(503);
  });
});
