import { createApi, unwrap } from "@/lib/api/client";
import { applyProblemToForm, ProblemError, toProblem } from "@/lib/api/problem";
import { can } from "@/lib/auth/roles";
import { Session } from "@/lib/auth/session";

describe("can", () => {
  it("matches the control plane's role guards", () => {
    expect(can("viewer", "endpoints:write")).toBe(false);
    expect(can("admin", "endpoints:write")).toBe(true);
    expect(can("admin", "deliveries:replay")).toBe(true);
    expect(can("admin", "api-keys:manage")).toBe(false);
    expect(can("admin", "users:read")).toBe(true);
    expect(can("admin", "users:write")).toBe(false);
    expect(can("owner", "api-keys:manage")).toBe(true);
    expect(can(undefined, "catalog:write")).toBe(false);
  });
});

describe("createApi", () => {
  const session = (tokens: string[], refreshOk = true) => {
    const s = new Session();
    let i = 0;
    vi.spyOn(s, "getToken").mockImplementation(() => tokens[Math.min(i, tokens.length - 1)] ?? null);
    vi.spyOn(s, "refresh").mockImplementation(async () => {
      i += 1;
      return refreshOk;
    });
    return s;
  };

  it("sends the token, and on 401 refreshes once and retries with the new token", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = (async (req: Request) => {
      seen.push(req.headers.get("authorization"));
      return seen.length === 1
        ? new Response("{}", { status: 401 })
        : new Response('{"id":"t"}', { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const api = createApi(session(["old", "new"]), fetchImpl);
    const r = await api.GET("/api/v1/tenant");
    expect(r.response.status).toBe(200);
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  });

  it("does not retry when the refresh fails, and never retries twice", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    expect((await createApi(session(["a"], false), fetchImpl).GET("/api/v1/tenant")).response.status).toBe(
      401,
    );
    expect(calls).toBe(1);
    calls = 0;
    await createApi(session(["a", "b"]), fetchImpl).GET("/api/v1/tenant");
    expect(calls).toBe(2);
  });

  it("does not refresh or retry other errors", async () => {
    for (const status of [403, 404, 500]) {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
      const s = session(["a", "b"]);
      expect((await createApi(s, fetchImpl).GET("/api/v1/tenant")).response.status).toBe(status);
      expect(calls).toBe(1);
      expect(s.refresh).not.toHaveBeenCalled();
    }
  });

  it("unwrap throws the problem for an error answer", () => {
    const problem = { type: "/problems/forbidden", title: "Not allowed", status: 403 };
    expect(() => unwrap({ error: problem, response: new Response(null, { status: 403 }) })).toThrow(
      ProblemError,
    );
  });
});

describe("applyProblemToForm", () => {
  it("puts field errors and mapped problem types on fields, and reports anything else", () => {
    const set: Array<[string, string]> = [];
    const setError = ((f: string, e: { message: string }) => set.push([f, e.message])) as never;
    expect(
      applyProblemToForm(
        { type: "x", title: "t", status: 422, errors: [{ field: "url", message: "bad" }] },
        setError,
      ),
    ).toBe(true);
    expect(
      applyProblemToForm(
        { type: "/problems/blocked-destination", title: "Blocked", status: 422, detail: "private" },
        setError,
        {
          "blocked-destination": "url",
        },
      ),
    ).toBe(true);
    expect(applyProblemToForm({ type: "/problems/other", title: "t", status: 500 }, setError, {})).toBe(
      false,
    );
    expect(set).toEqual([
      ["url", "bad"],
      ["url", "private"],
    ]);
  });

  it("toProblem turns network errors into a readable problem", () => {
    expect(toProblem(new TypeError("Failed to fetch")).title).toBe("Cannot reach the server");
  });
});
