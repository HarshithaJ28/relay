import { backoffDelay, type LiveEvent, runStream } from "@/lib/live/stream";

function body(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
}

const DELIVERY = 'event: delivery\ndata: {"type":"delivery","delivery_id":"d1","status":"succeeded"}\n\n';

function harness(responses: Array<() => Response | Promise<Response>>) {
  const controller = new AbortController();
  const calls: RequestInit[] = [];
  const delays: number[] = [];
  const events: LiveEvent[] = [];
  let reconnects = 0;
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = responses[i++];
    if (!next) {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
    return next();
  }) as unknown as typeof fetch;
  return {
    controller,
    calls,
    delays,
    events,
    get reconnects() {
      return reconnects;
    },
    options: {
      getToken: (): string | null => "tok",
      refresh: async () => true,
      onEvent: (e: LiveEvent) => events.push(e),
      onReconnect: () => {
        reconnects += 1;
      },
      fetchImpl,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
      random: () => 0.999,
    },
  };
}

describe("backoffDelay", () => {
  it("doubles up to the cap and never exceeds it", () => {
    const max = (n: number) => backoffDelay(n, 1000, 30000, () => 0.999999);
    expect([0, 1, 2, 3, 4].map(max)).toEqual([999, 1999, 3999, 7999, 15999]);
    expect(max(5)).toBe(29999);
    expect(max(50)).toBe(29999);
    expect(backoffDelay(3, 1000, 30000, () => 0)).toBe(0);
  });
});

describe("runStream", () => {
  it("sends the token in the Authorization header, not the URL, and delivers events", async () => {
    const h = harness([() => new Response(body([": connected\n\n", DELIVERY]))]);
    await runStream(h.options, h.controller.signal);
    expect(h.calls[0]?.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(h.events).toEqual([{ type: "delivery", delivery_id: "d1", status: "succeeded" }]);
  });

  it("reconnects with growing delays and calls onReconnect only after a reconnect", async () => {
    const h = harness([
      () => new Response(body([DELIVERY])), // opens, then the server closes the stream
      () => new Response("down", { status: 502 }),
      () => Promise.reject(new TypeError("network")),
      () => new Response(body([DELIVERY])), // opens again
    ]);
    await runStream(h.options, h.controller.signal);
    expect(h.reconnects).toBe(1);
    expect(h.events).toHaveLength(2);
    // after the first open the counter is 0, then grows while failing, then resets on open
    expect(h.delays).toEqual([999, 1998, 3996, 999]);
  });

  it("refreshes on 401 and stops when the refresh fails", async () => {
    let refreshed = 0;
    const h = harness([() => new Response("", { status: 401 }), () => new Response("", { status: 401 })]);
    h.options.refresh = async () => ++refreshed === 1;
    await runStream(h.options, h.controller.signal);
    expect(refreshed).toBe(2);
    expect(h.calls).toHaveLength(2);
    expect(h.delays).toEqual([]);
  });

  it("skips malformed and unknown events", async () => {
    const h = harness([
      () =>
        new Response(body(["event: delivery\ndata: {not json\n\n", 'data: {"type":"other"}\n\n', DELIVERY])),
    ]);
    await runStream(h.options, h.controller.signal);
    expect(h.events).toHaveLength(1);
  });

  it("does nothing when logged out", async () => {
    const h = harness([() => new Response(body([DELIVERY]))]);
    h.options.getToken = () => null;
    await runStream(h.options, h.controller.signal);
    expect(h.calls).toHaveLength(0);
  });
});
