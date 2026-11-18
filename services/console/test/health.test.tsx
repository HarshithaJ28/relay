import { act, render, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { BreakerPanel, EndpointHealthPage, HEALTH_REFETCH_MS } from "@/components/health/endpoint-health";
import { applyBreakerEvent, breakerState, errorRows, type Health } from "@/lib/api/health";
import { origin, renderAs } from "./harness";

const ID = "11111111-1111-4111-8111-111111111111";
const health = (over: Partial<Health> = {}): Health => ({
  endpoint_id: ID,
  window_hours: 24,
  attempts: 40,
  successes: 30,
  success_rate: 0.75,
  errors_by_class: { http_5xx: 7, timeout: 3 },
  active_deliveries: 2,
  breaker: { state: "closed" },
  ...over,
});
const endpoint = {
  id: ID,
  url: "https://hooks.example.com/relay",
  status: "enabled",
  concurrency_limit: 10,
  breaker_until: null,
  signing_secrets: [],
  created_at: "2026-11-01T00:00:00.000Z",
};

describe("breakerState", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("is closed, open until the pause ends, then probing from that moment", () => {
    expect(breakerState({ state: "closed" }, now)).toEqual({ state: "closed" });
    expect(breakerState({ state: "open", until: "2026-11-18T12:00:01Z" }, now)).toEqual({
      state: "open",
      until: "2026-11-18T12:00:01Z",
    });
    expect(breakerState({ state: "open", until: "2026-11-18T12:00:00Z" }, now)).toEqual({
      state: "probing",
      since: "2026-11-18T12:00:00Z",
    });
    expect(breakerState({ state: "open", until: null }, now)).toEqual({ state: "probing", since: null });
  });
});

describe("applyBreakerEvent", () => {
  it("opens this endpoint's breaker with the new time, and leaves anything else alone", () => {
    const h = health();
    const opened = applyBreakerEvent(h, {
      type: "breaker",
      endpoint_id: ID,
      state: "open",
      until: "2026-11-18T13:00:00Z",
      at: 1,
    });
    expect(opened?.breaker).toEqual({ state: "open", until: "2026-11-18T13:00:00Z" });
    expect(opened?.attempts).toBe(40);
    expect(
      applyBreakerEvent(h, { type: "breaker", endpoint_id: "other", state: "open", until: "x", at: 1 }),
    ).toBe(h);
    expect(
      applyBreakerEvent(h, {
        type: "delivery",
        delivery_id: "d",
        endpoint_id: ID,
        status: "dead",
        attempt: 1,
        error_class: null,
        at: 1,
      }),
    ).toBe(h);
    expect(
      applyBreakerEvent(undefined, { type: "breaker", endpoint_id: ID, state: "open", until: "x", at: 1 }),
    ).toBeUndefined();
  });
});

describe("errorRows", () => {
  it("lists error classes most frequent first, with their share", () => {
    expect(errorRows({ timeout: 3, http_5xx: 7, dns: 3 })).toEqual([
      { errorClass: "http_5xx", count: 7, share: 7 / 13 },
      { errorClass: "dns", count: 3, share: 3 / 13 },
      { errorClass: "timeout", count: 3, share: 3 / 13 },
    ]);
    expect(errorRows({})).toEqual([]);
  });
});

describe("BreakerPanel", () => {
  afterEach(() => vi.useRealTimers());
  it("turns from open into probing when the pause ends, without a refetch", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-18T12:00:00Z") });
    render(<BreakerPanel breaker={{ state: "open", until: "2026-11-18T12:00:30Z" }} />);
    expect(screen.getByTestId("breaker")).toHaveTextContent("Open");
    expect(screen.getByTestId("breaker")).toHaveTextContent("nothing is sent");
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    expect(screen.getByTestId("breaker")).toHaveTextContent("Probing");
    expect(screen.getByTestId("breaker")).toHaveTextContent("one delivery as a probe");
  });
});

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("endpoint health page", () => {
  it("shows the breaker, the success rate, active deliveries and errors by class", async () => {
    server.use(
      http.get(`${origin}/api/v1/endpoints/${ID}`, () => HttpResponse.json(endpoint)),
      http.get(`${origin}/api/v1/endpoints/${ID}/health`, () => HttpResponse.json(health())),
    );
    await renderAs(server, "viewer", <EndpointHealthPage id={ID} />);
    expect(await screen.findByTestId("success-rate")).toHaveTextContent("75.0%");
    expect(screen.getByText("30 of 40 attempts")).toBeInTheDocument();
    expect(screen.getByTestId("breaker")).toHaveTextContent("Closed");
    expect(await screen.findByRole("heading", { name: endpoint.url })).toBeInTheDocument();
    const errors = within(screen.getByRole("list", { name: "Errors by class" })).getAllByRole("listitem");
    expect(errors.map((li) => li.textContent)).toEqual(["http_5xx7", "timeout3"]);
    expect(screen.getByRole("link", { name: /deliveries/ })).toHaveAttribute(
      "href",
      `/deliveries?endpoint=${ID}`,
    );
  });

  it("shows no success rate when there were no attempts", async () => {
    server.use(
      http.get(`${origin}/api/v1/endpoints/${ID}`, () => HttpResponse.json(endpoint)),
      http.get(`${origin}/api/v1/endpoints/${ID}/health`, () =>
        HttpResponse.json(health({ attempts: 0, successes: 0, success_rate: null, errors_by_class: {} })),
      ),
    );
    await renderAs(server, "viewer", <EndpointHealthPage id={ID} />);
    expect(await screen.findByTestId("success-rate")).toHaveTextContent("—");
    expect(screen.getByText("No errors.")).toBeInTheDocument();
  });

  it("opens the breaker at once on a breaker event, and shows it closed after a successful probe", async () => {
    let state: Health["breaker"] = { state: "closed" };
    let calls = 0;
    server.use(
      http.get(`${origin}/api/v1/endpoints/${ID}`, () => HttpResponse.json(endpoint)),
      http.get(`${origin}/api/v1/endpoints/${ID}/health`, () => {
        calls += 1;
        return HttpResponse.json(health({ breaker: state }));
      }),
    );
    const live = await renderAs(server, "viewer", <EndpointHealthPage id={ID} />);
    await screen.findByText("Closed");
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    state = { state: "open", until };
    act(() => live.emit({ type: "breaker", endpoint_id: ID, state: "open", until, at: 1 }));
    expect(await screen.findByText("Open")).toBeInTheDocument(); // before any refetch
    // the probe succeeds: the server closes the breaker; only a delivery event arrives
    state = { state: "closed" };
    act(() =>
      live.emit({
        type: "delivery",
        delivery_id: "d",
        endpoint_id: ID,
        status: "succeeded",
        attempt: 1,
        error_class: null,
        at: 2,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("breaker")).toHaveTextContent("Closed"), {
      timeout: HEALTH_REFETCH_MS * 4,
    });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("ignores events for other endpoints", async () => {
    let calls = 0;
    server.use(
      http.get(`${origin}/api/v1/endpoints/${ID}`, () => HttpResponse.json(endpoint)),
      http.get(`${origin}/api/v1/endpoints/${ID}/health`, () => {
        calls += 1;
        return HttpResponse.json(health());
      }),
    );
    const live = await renderAs(server, "viewer", <EndpointHealthPage id={ID} />);
    await screen.findByText("Closed");
    act(() =>
      live.emit({
        type: "breaker",
        endpoint_id: "other",
        state: "open",
        until: new Date(Date.now() + 60_000).toISOString(),
        at: 1,
      }),
    );
    await new Promise((r) => setTimeout(r, HEALTH_REFETCH_MS + 200));
    expect(screen.getByTestId("breaker")).toHaveTextContent("Closed");
    expect(calls).toBe(1);
  });
});
