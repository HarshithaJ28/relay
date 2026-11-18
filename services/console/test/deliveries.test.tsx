import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { DeliveriesPage, REFETCH_DEBOUNCE_MS } from "@/components/deliveries/deliveries-page";
import { DeliveryDetailPage, gapLabel } from "@/components/deliveries/delivery-detail";
import { applyLiveEvent, type Delivery, filtersToParams, parseFilters } from "@/lib/api/deliveries";
import { AuthProvider } from "@/lib/auth/context";
import { Session } from "@/lib/auth/session";
import { LiveContext } from "@/lib/live/context";
import type { LiveEvent } from "@/lib/live/stream";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => "/deliveries",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const origin = "http://localhost:3000";
const EP = "11111111-1111-4111-8111-111111111111";
const OTHER_EP = "22222222-2222-4222-8222-222222222222";
const delivery = (id: string, over: Partial<Delivery> = {}): Delivery => ({
  id,
  endpoint_id: EP,
  event_id: `e-${id}`,
  status: "scheduled",
  attempt_count: 0,
  next_attempt_at: null,
  message_id: `m-${id}`,
  replay_of: null,
  last_error_class: null,
  created_at: "2026-11-18T10:00:00.000Z",
  updated_at: "2026-11-18T10:00:00.000Z",
  ...over,
});
const event = (over: Partial<Extract<LiveEvent, { type: "delivery" }>> = {}): LiveEvent => ({
  type: "delivery",
  delivery_id: "d1",
  endpoint_id: EP,
  status: "succeeded",
  attempt: 1,
  error_class: null,
  at: 1,
  ...over,
});
const pagesOf = (...pages: Delivery[][]) => ({
  pages: pages.map((data, i) => ({ data, next_cursor: i < pages.length - 1 ? `c${i}` : null })),
  pageParams: pages.map((_, i) => (i ? `c${i - 1}` : undefined)),
});

describe("filters", () => {
  it("round-trip through the URL and drop malformed values instead of sending them", () => {
    const f = {
      endpoint: EP,
      status: "dead" as const,
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-02T00:00:00.000Z",
    };
    expect(parseFilters(filtersToParams(f))).toEqual(f);
    expect(parseFilters(new URLSearchParams("endpoint=x;drop&status=bogus&from=yesterday&to="))).toEqual({});
  });
});

describe("applyLiveEvent", () => {
  it("updates a row on screen in place, never lowering its attempt count", () => {
    const pages = pagesOf([delivery("d0"), delivery("d1", { attempt_count: 3 })], [delivery("d2")]);
    const a = applyLiveEvent(
      pages,
      event({ delivery_id: "d1", status: "dead", attempt: 2, error_class: "http_5xx" }),
      {},
    );
    expect(a.kind).toBe("patch");
    const row = a.kind === "patch" ? a.pages.pages[0]?.data[1] : undefined;
    expect(row).toMatchObject({ status: "dead", attempt_count: 3, last_error_class: "http_5xx" });
    const b = applyLiveEvent(pages, event({ delivery_id: "d2", attempt: 4 }), {});
    expect(b.kind === "patch" && b.pages.pages[1]?.data[0]?.attempt_count).toBe(4);
  });

  it("refetches for a delivery not on screen that matches the filters, and ignores the rest", () => {
    const pages = pagesOf([delivery("d0")]);
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(applyLiveEvent(pages, event(), {}, now).kind).toBe("refetch");
    expect(applyLiveEvent(undefined, event(), {}, now).kind).toBe("refetch");
    expect(applyLiveEvent(pages, event(), { endpoint: EP, status: "succeeded" }, now).kind).toBe("refetch");
    expect(applyLiveEvent(pages, event(), { endpoint: OTHER_EP }, now).kind).toBe("ignore");
    expect(applyLiveEvent(pages, event(), { status: "dead" }, now).kind).toBe("ignore");
    expect(applyLiveEvent(pages, event(), { to: "2026-11-18T11:00:00Z" }, now).kind).toBe("ignore");
    expect(applyLiveEvent(pages, event(), { to: "2026-11-18T13:00:00Z" }, now).kind).toBe("refetch");
    expect(
      applyLiveEvent(pages, { type: "breaker", endpoint_id: EP, state: "open", until: "", at: 1 }, {}, now)
        .kind,
    ).toBe("ignore");
  });
});

describe("gapLabel", () => {
  it("shows the time since the previous attempt", () => {
    expect(gapLabel(undefined, "2026-11-18T10:00:00Z")).toBe("—");
    expect(gapLabel("2026-11-18T10:00:00Z", "2026-11-18T10:00:07Z")).toBe("+7s");
    expect(gapLabel("2026-11-18T10:00:00Z", "2026-11-18T10:02:05Z")).toBe("+2m 05s");
    expect(gapLabel("2026-11-18T10:00:00Z", "2026-11-18T13:04:00Z")).toBe("+3h 04m");
  });
});

// ---------------------------------------------------------------- components
const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  nav.search = "";
  nav.replace.mockReset();
  vi.useRealTimers();
});
afterAll(() => server.close());

function liveHarness() {
  const listeners = new Set<(e: LiveEvent) => void>();
  return {
    emit: (e: LiveEvent) =>
      act(() => {
        for (const fn of listeners) fn(e);
      }),
    value: {
      status: "open" as const,
      subscribe: (fn: (e: LiveEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

async function mount(ui: ReactNode) {
  server.use(
    http.post(`${origin}/api/v1/auth/refresh`, () =>
      HttpResponse.json({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 900,
        user: { id: "u", tenant_id: "t", email: "a@example.com", role: "viewer" },
      }),
    ),
    http.get(`${origin}/api/v1/endpoints`, () =>
      HttpResponse.json([
        {
          id: EP,
          url: "https://hooks.example.com/relay",
          status: "enabled",
          concurrency_limit: 10,
          breaker_until: null,
          signing_secrets: [],
          created_at: "2026-11-01T00:00:00.000Z",
        },
      ]),
    ),
  );
  const session = new Session({ fetchImpl: (input, init) => fetch(new URL(String(input), origin), init) });
  await session.refresh();
  const live = liveHarness();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider session={session}>
        <LiveContext.Provider value={live.value}>{ui}</LiveContext.Provider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return live;
}

describe("deliveries list", () => {
  it("pages with the cursor and passes the URL's filters to the API", async () => {
    nav.search = `endpoint=${EP}&status=dead`;
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${origin}/api/v1/deliveries`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        seen.push(q);
        return q.get("cursor")
          ? HttpResponse.json({ data: [delivery("d2", { status: "dead" })], next_cursor: null })
          : HttpResponse.json({ data: [delivery("d1", { status: "dead" })], next_cursor: "c1" });
      }),
    );
    await mount(<DeliveriesPage />);
    expect(await screen.findByRole("link", { name: "Delivery d1" })).toBeInTheDocument();
    expect(screen.getAllByText("https://hooks.example.com/relay").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Delivery d2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(seen[0]?.get("endpoint_id")).toBe(EP);
    expect(seen[0]?.get("status")).toBe("dead");
    expect(seen[1]?.get("cursor")).toBe("c1");
  });

  it("writes a changed filter into the URL", async () => {
    server.use(
      http.get(`${origin}/api/v1/deliveries`, () => HttpResponse.json({ data: [], next_cursor: null })),
    );
    await mount(<DeliveriesPage />);
    expect(await screen.findByText("No deliveries match these filters.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "dead");
    expect(nav.replace).toHaveBeenLastCalledWith("/deliveries?status=dead");
  });

  it("updates a shown row live, and refetches once for a burst of new deliveries", async () => {
    let calls = 0;
    server.use(
      http.get(`${origin}/api/v1/deliveries`, () => {
        calls += 1;
        return HttpResponse.json({
          data: calls === 1 ? [delivery("d1")] : [delivery("d9"), delivery("d1", { status: "succeeded" })],
          next_cursor: null,
        });
      }),
    );
    const live = await mount(<DeliveriesPage />);
    const row = (await screen.findByRole("link", { name: "Delivery d1" })).closest("tr") as HTMLElement;
    expect(within(row).getByText("Scheduled")).toBeInTheDocument();
    live.emit(event({ delivery_id: "d1", status: "succeeded", attempt: 1 }));
    expect(await within(row).findByText("Succeeded")).toBeInTheDocument();
    expect(calls).toBe(1);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    live.emit(event({ delivery_id: "d7" }));
    live.emit(event({ delivery_id: "d8" }));
    live.emit(event({ delivery_id: "d9" }));
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(REFETCH_DEBOUNCE_MS + 10));
    expect(await screen.findByRole("link", { name: "Delivery d9" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

describe("delivery detail", () => {
  const detail = (over: object = {}) => ({
    ...delivery("d1", { status: "dead", attempt_count: 2, last_error_class: "http_5xx" }),
    event: {
      id: "e1",
      event_type: "order.paid",
      payload: { order: 42 },
      payload_expires_at: "2026-11-25T10:00:00.000Z",
      payload_expired: false,
    },
    attempts: [
      {
        attempt_no: 1,
        counted: true,
        outcome: "retry",
        status_code: 503,
        error_class: "http_5xx",
        created_at: "2026-11-18T10:00:00.000Z",
      },
      {
        attempt_no: 2,
        counted: true,
        outcome: "dead",
        status_code: 503,
        error_class: "http_5xx",
        created_at: "2026-11-18T10:02:05.000Z",
      },
    ],
    ...over,
  });

  it("shows the payload, every attempt with its outcome, status, error class and timing", async () => {
    server.use(http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail())));
    await mount(<DeliveryDetailPage id="d1" />);
    expect(await screen.findByTestId("payload")).toHaveTextContent('"order": 42');
    expect(screen.getByText("Event: order.paid")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Failed, will retry");
    expect(rows[1]).toHaveTextContent("Failed, gave up");
    expect(rows[1]).toHaveTextContent("503");
    expect(rows[1]).toHaveTextContent("+2m 05s");
    expect(screen.getByText("How long each request took is not recorded.")).toBeInTheDocument();
  });

  it("says when the payload expired instead of showing it", async () => {
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () =>
        HttpResponse.json(
          detail({
            event: {
              id: "e1",
              event_type: "order.paid",
              payload: null,
              payload_expires_at: "2026-11-10T10:00:00.000Z",
              payload_expired: true,
            },
          }),
        ),
      ),
    );
    await mount(<DeliveryDetailPage id="d1" />);
    expect(await screen.findByTestId("payload-expired")).toHaveTextContent("expired on");
    expect(screen.queryByTestId("payload")).not.toBeInTheDocument();
  });

  it("refetches when a live event concerns this delivery, and not for others", async () => {
    let calls = 0;
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () => {
        calls += 1;
        return HttpResponse.json(detail());
      }),
    );
    const live = await mount(<DeliveryDetailPage id="d1" />);
    await screen.findByTestId("payload");
    live.emit(event({ delivery_id: "other" }));
    live.emit(event({ delivery_id: "d1" }));
    await waitFor(() => expect(calls).toBe(2));
  });

  it("shows a missing delivery as a problem", async () => {
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () =>
        HttpResponse.json(
          { type: "/problems/not-found", title: "Delivery not found", status: 404 },
          { status: 404 },
        ),
      ),
    );
    await mount(<DeliveryDetailPage id="d1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Delivery not found");
  });
});
