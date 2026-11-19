import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { OverviewPage } from "@/components/overview/overview-page";
import { chartRows, percent, rangeFor, type Stats } from "@/lib/api/overview";
import { origin, problem, renderAs } from "./harness";

const counts = (o: Partial<Stats["totals"]["deliveries"]> = {}) => ({
  scheduled: 0,
  queued: 0,
  in_flight: 0,
  succeeded: 0,
  dead: 0,
  cancelled: 0,
  ...o,
});
const stats = (bucket: "hour" | "day" = "hour"): Stats => ({
  from: "2026-11-18T10:00:00.000Z",
  to: "2026-11-18T12:00:00.000Z",
  bucket,
  generated_at: "2026-11-18T11:30:00.000Z",
  totals: {
    events: 12,
    attempts: 15,
    deliveries: counts({ succeeded: 9, dead: 3, scheduled: 1, queued: 1 }),
    success_rate: 0.75,
  },
  buckets: [
    {
      start: "2026-11-18T10:00:00.000Z",
      events: 10,
      attempts: 12,
      deliveries: counts({ succeeded: 9, dead: 1, in_flight: 2 }),
      success_rate: 0.9,
    },
    {
      start: "2026-11-18T11:00:00.000Z",
      events: 2,
      attempts: 3,
      deliveries: counts({ scheduled: 1, queued: 1, cancelled: 1 }),
      success_rate: null,
    },
  ],
});
const usage = { plan: "free", month_to_date: { events: 2500, limit: 10000, share: 0.25 }, daily: [] };

describe("rangeFor", () => {
  const now = Date.parse("2026-11-18T11:37:12.345Z");
  it("ends at the end of the current UTC bucket and covers whole buckets", () => {
    expect(rangeFor("24h", now)).toEqual({
      from: "2026-11-17T12:00:00.000Z",
      to: "2026-11-18T12:00:00.000Z",
      bucket: "hour",
    });
    expect(rangeFor("7d", now)).toEqual({
      from: "2026-11-12T00:00:00.000Z",
      to: "2026-11-19T00:00:00.000Z",
      bucket: "day",
    });
    expect(rangeFor("30d", now)).toEqual({
      from: "2026-10-20T00:00:00.000Z",
      to: "2026-11-19T00:00:00.000Z",
      bucket: "day",
    });
  });

  it("gives the same request throughout a bucket, so the server's cache is used", () => {
    const a = rangeFor("24h", Date.parse("2026-11-18T11:00:00.000Z"));
    const b = rangeFor("24h", Date.parse("2026-11-18T11:59:59.999Z"));
    expect(a).toEqual(b);
    expect(rangeFor("24h", Date.parse("2026-11-18T12:00:00.000Z"))).not.toEqual(a);
  });

  it("stays inside the server's limits (31 days, hourly up to 7)", () => {
    for (const p of ["24h", "7d", "30d"] as const) {
      const r = rangeFor(p, now);
      const days = (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(r.bucket === "hour" ? 7 : 31);
    }
  });
});

describe("chartRows", () => {
  it("groups statuses into succeeded, failed and in progress, and keeps empty rates empty", () => {
    const rows = chartRows(stats());
    expect(rows[0]).toMatchObject({ events: 10, succeeded: 9, failed: 1, inProgress: 2, successRate: 90 });
    expect(rows[1]).toMatchObject({
      events: 2,
      succeeded: 0,
      failed: 0,
      inProgress: 2,
      cancelled: 1,
      successRate: null,
    });
  });

  it("labels day buckets by their UTC date, whatever the browser's time zone", () => {
    expect(new Date("2026-11-18T00:00:00Z").getDate()).toBe(17); // the suite runs in New York
    const s = stats("day");
    s.buckets = [{ ...s.buckets[0], start: "2026-11-18T00:00:00.000Z" } as Stats["buckets"][number]];
    expect(chartRows(s)[0]?.label).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
        new Date("2026-11-18T00:00:00Z"),
      ),
    );
  });

  it("rounds the rate to one decimal and shows a missing one as a dash", () => {
    const s = stats();
    s.buckets = [{ ...s.buckets[0], success_rate: 2 / 3 } as Stats["buckets"][number]];
    expect(chartRows(s)[0]?.successRate).toBe(66.7);
    expect(percent(null)).toBe("—");
    expect(percent(0.25)).toBe("25.0%");
  });
});

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("overview page", () => {
  it("shows the totals, usage against the plan, and each chart's data as a table", async () => {
    server.use(
      http.get(`${origin}/api/v1/stats`, () => HttpResponse.json(stats())),
      http.get(`${origin}/api/v1/usage`, () => HttpResponse.json(usage)),
    );
    await renderAs(server, "viewer", <OverviewPage />);
    expect(await screen.findByText("Success rate", { selector: "dt" })).toBeInTheDocument();
    const tiles = screen.getAllByRole("definition").map((d) => d.textContent);
    expect(tiles).toEqual(expect.arrayContaining(["12", "14", "75.0%", "3", "of 12 finished deliveries"]));
    expect(await screen.findByTestId("usage")).toHaveTextContent("2,500 of 10,000 on the free plan (25.0%)");
    expect(screen.getByRole("meter", { name: /Events this month/ })).toHaveAttribute("value", "2500");
    const outcomes = screen.getByText("Deliveries by outcome").closest("figure") as HTMLElement;
    expect(within(outcomes).getByRole("list", { name: /legend/ })).toHaveTextContent(
      "SucceededFailedIn progress",
    );
    await userEvent.click(within(outcomes).getByRole("button", { name: "Show as table" }));
    const rows = within(within(outcomes).getByRole("table")).getAllByRole("row");
    expect(rows[1]).toHaveTextContent(/9\s*1\s*2\s*0$/);
    const rate = screen.getByText("Success rate", { selector: "span" }).closest("figure") as HTMLElement;
    await userEvent.click(within(rate).getByRole("button", { name: "Show as table" }));
    expect(within(within(rate).getByRole("table")).getAllByRole("row")[2]).toHaveTextContent("—");
  });

  it("asks for the chosen range with whole buckets", async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${origin}/api/v1/stats`, ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(stats());
      }),
      http.get(`${origin}/api/v1/usage`, () => HttpResponse.json(usage)),
    );
    await renderAs(server, "viewer", <OverviewPage />);
    await screen.findByText("Success rate", { selector: "dt" });
    expect(seen[0]?.get("bucket")).toBe("hour");
    await userEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    await waitFor(() => expect(seen.at(-1)?.get("bucket")).toBe("day"));
    const last = seen.at(-1) as URLSearchParams;
    expect((Date.parse(last.get("to") ?? "") - Date.parse(last.get("from") ?? "")) / 86_400_000).toBe(30);
    expect(screen.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a problem from the stats endpoint", async () => {
    server.use(
      http.get(`${origin}/api/v1/stats`, () => problem(422, "invalid-range", "Invalid stats range")),
      http.get(`${origin}/api/v1/usage`, () => HttpResponse.json(usage)),
    );
    await renderAs(server, "viewer", <OverviewPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid stats range");
  });
});
