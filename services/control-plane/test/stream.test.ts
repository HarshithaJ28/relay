import { Valkey } from "iovalkey";
import { describe, expect, inject, it } from "vitest";
import { valkeySubscriber } from "../src/live.js";
import { bearer, cleanDatabase, makeApp, signup } from "./helpers.js";

cleanDatabase();

/** Read server-sent events from a live stream until `count` events or the timeout. */
async function readEvents(url: string, token: string, count: number, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const events: { event: string; data: unknown }[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
        if (events.length >= count)
          return { status: res.status, type: res.headers.get("content-type"), events };
      }
    }
  } catch {
    // aborted by the timeout
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { status: res.status, type: res.headers.get("content-type"), events };
}

describe("live stream", () => {
  it("relays the tenant's own updates from Valkey and nobody else's", async () => {
    const url = inject("valkeyUrl");
    const app = await makeApp({ subscribe: valkeySubscriber(url) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const a = await signup(app);
    const b = await signup(app);
    const publisher = new Valkey(url);
    try {
      const reading = readEvents(`http://127.0.0.1:${address.port}/api/v1/stream`, a.token, 2);
      await new Promise((r) => setTimeout(r, 500)); // let the subscription start
      await publisher.publish(
        `relay:live:${b.tenantId}`,
        JSON.stringify({ type: "delivery", delivery_id: "b-1" }),
      );
      await publisher.publish(
        `relay:live:${a.tenantId}`,
        JSON.stringify({ type: "delivery", delivery_id: "a-1", status: "succeeded" }),
      );
      await publisher.publish(
        `relay:live:${a.tenantId}`,
        JSON.stringify({ type: "breaker", endpoint_id: "e", state: "open" }),
      );
      const result = await reading;
      expect(result.status).toBe(200);
      expect(result.type).toMatch(/text\/event-stream/);
      expect(result.events).toEqual([
        { event: "delivery", data: { type: "delivery", delivery_id: "a-1", status: "succeeded" } },
        { event: "breaker", data: { type: "breaker", endpoint_id: "e", state: "open" } },
      ]);
    } finally {
      publisher.disconnect();
      await app.close();
    }
  });

  it("needs a valid access token, and says so when live updates are off", async () => {
    const app = await makeApp();
    const a = await signup(app);
    expect((await app.inject({ method: "GET", url: "/api/v1/stream" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/stream", headers: bearer(a) })).statusCode).toBe(
      503,
    );
  });
});
