import { AuthError, refreshDelayMs, Session } from "@/lib/auth/session";

const USER = { id: "u1", tenant_id: "t1", email: "a@example.com", role: "owner" as const };
const ok = (token: string, expires_in = 900) =>
  new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in, user: USER }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const problem = (status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "/problems/x", title: "No", status, detail: "nope" }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });

function harness(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let i = 0;
  const session = new Session({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = responses[i++];
      if (!next) throw new Error("unexpected request");
      return next();
    }) as unknown as typeof fetch,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  return { session, calls, timers };
}

describe("refreshDelayMs", () => {
  it("refreshes a minute early, or halfway through a short token's life", () => {
    expect(refreshDelayMs(900)).toBe(840_000);
    expect(refreshDelayMs(60)).toBe(30_000);
    expect(refreshDelayMs(0)).toBe(0);
  });
});

describe("Session", () => {
  it("starts loading, and a successful refresh on load logs in and schedules the next one", async () => {
    const h = harness([() => ok("t1", 900)]);
    expect(h.session.state.status).toBe("loading");
    expect(await h.session.refresh()).toBe(true);
    expect(h.session.getToken()).toBe("t1");
    expect(h.session.state).toEqual({ status: "authenticated", user: USER });
    expect(h.calls[0]?.url).toBe("/api/v1/auth/refresh");
    expect(h.calls[0]?.init.credentials).toBe("same-origin");
    expect(h.timers.map((t) => t.ms)).toEqual([840_000]);
  });

  it("treats a failed refresh, or a network error, as logged out", async () => {
    const h = harness([() => problem(401), () => Promise.reject(new TypeError("offline"))]);
    expect(await h.session.refresh()).toBe(false);
    expect(h.session.state.status).toBe("anonymous");
    expect(await h.session.refresh()).toBe(false);
    expect(h.session.getToken()).toBeNull();
  });

  it("shares one refresh between concurrent callers, so the rotating cookie is used once", async () => {
    let release: (r: Response) => void = () => {};
    const h = harness([() => new Promise<Response>((r) => (release = r)), () => ok("t2")]);
    const all = Promise.all([h.session.refresh(), h.session.refresh(), h.session.refresh()]);
    release(ok("t1"));
    expect(await all).toEqual([true, true, true]);
    expect(h.calls).toHaveLength(1);
    await h.session.refresh(); // a later refresh is a new request
    expect(h.calls).toHaveLength(2);
  });

  it("the scheduled timer refreshes, and a new session replaces the old timer", async () => {
    const h = harness([() => ok("t1", 900), () => ok("t2", 900)]);
    await h.session.refresh();
    h.timers[0]?.fn();
    await vi.waitFor(() => expect(h.session.getToken()).toBe("t2"));
    expect(h.timers[0]?.cleared).toBe(true);
    expect(h.timers).toHaveLength(2);
  });

  it("login throttled: the error carries Retry-After and the session stays anonymous", async () => {
    const h = harness([() => problem(429, { "retry-after": "840" })]);
    const err = await h.session.login("a@example.com", "wrong").catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).retryAfter).toBe(840);
    expect((err as AuthError).problem.status).toBe(429);
    expect(h.session.getToken()).toBeNull();
  });

  it("logout clears the token and the timer even if the request fails", async () => {
    const h = harness([() => ok("t1"), () => Promise.reject(new TypeError("offline"))]);
    await h.session.refresh();
    await h.session.logout().catch(() => {});
    expect(h.session.getToken()).toBeNull();
    expect(h.session.state.status).toBe("anonymous");
    expect(h.timers[0]?.cleared).toBe(true);
  });

  it("notifies subscribers of every change", async () => {
    const h = harness([() => ok("t1"), () => problem(401)]);
    const seen: string[] = [];
    h.session.subscribe((s) => seen.push(s.status));
    await h.session.refresh();
    await h.session.refresh();
    expect(seen).toEqual(["authenticated", "anonymous"]);
  });
});
