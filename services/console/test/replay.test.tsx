import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { DeliveryDetailPage } from "@/components/deliveries/delivery-detail";
import { BulkReplay } from "@/components/replay/bulk-replay";
import { bulkKey, defaultMode, expiredFromProblem, replayBlocked } from "@/lib/api/replay";
import { origin, problem, renderAs } from "./harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/deliveries",
  useSearchParams: () => new URLSearchParams(),
}));

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const detail = (status: string, event: object = {}) => ({
  id: "d1",
  endpoint_id: "e",
  event_id: "ev",
  status,
  attempt_count: 1,
  next_attempt_at: null,
  message_id: "m1",
  replay_of: null,
  last_error_class: null,
  created_at: "2026-11-18T10:00:00.000Z",
  updated_at: "2026-11-18T10:00:00.000Z",
  event: {
    id: "ev",
    event_type: "order.paid",
    payload: { a: 1 },
    payload_expires_at: "2026-11-25T10:00:00.000Z",
    payload_expired: false,
    ...event,
  },
  attempts: [],
});

describe("replay rules", () => {
  it("defaults to a new id for succeeded deliveries and reuse for the rest", () => {
    expect(defaultMode("succeeded")).toBe("new");
    expect(defaultMode("dead")).toBe("reuse");
    expect(defaultMode("cancelled")).toBe("reuse");
  });

  it("blocks active deliveries and expired payloads", () => {
    const d = (status: string, expired = false) =>
      ({
        status,
        event: {
          id: "e",
          payload: null,
          payload_expired: expired,
          payload_expires_at: "2026-11-10T00:00:00.000Z",
        },
      }) as never;
    expect(replayBlocked(d("scheduled"))).toEqual({ reason: "active" });
    expect(replayBlocked(d("in_flight"))).toEqual({ reason: "active" });
    expect(replayBlocked(d("dead", true))).toEqual({ reason: "expired", at: "2026-11-10T00:00:00.000Z" });
    expect(replayBlocked(d("dead"))).toBeNull();
  });

  it("recognises a 410 replay-unavailable problem and only that", () => {
    expect(
      expiredFromProblem({
        type: "/problems/replay-unavailable",
        title: "x",
        status: 410,
        expired_at: "2026-11-10T00:00:00Z",
      }),
    ).toEqual({
      at: "2026-11-10T00:00:00Z",
    });
    expect(
      expiredFromProblem({ type: "/problems/replay-unavailable", title: "x", status: 410, expired_at: "" }),
    ).toEqual({ at: null });
    expect(expiredFromProblem({ type: "/problems/gone", title: "x", status: 410 })).toBeNull();
    expect(expiredFromProblem({ type: "/problems/replay-unavailable", title: "x", status: 409 })).toBeNull();
  });

  it("gives every bulk setting its own preview key", () => {
    const base = { status: "dead" as const, message_id: "reuse" as const };
    const keys = new Set([
      bulkKey(base),
      bulkKey({ ...base, status: "succeeded" }),
      bulkKey({ ...base, message_id: "new" }),
      bulkKey({ ...base, endpoint_id: "x" }),
      bulkKey({ ...base, from: "2026-11-01T00:00:00Z" }),
      bulkKey({ ...base, to: "2026-11-01T00:00:00Z" }),
    ]);
    expect(keys.size).toBe(6);
  });
});

describe("single replay", () => {
  it("is hidden from viewers and for deliveries still in progress", async () => {
    server.use(http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("dead"))));
    await renderAs(server, "viewer", <DeliveryDetailPage id="d1" />);
    await screen.findByText("Event: order.paid");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });

  it("is not offered while a delivery is still in progress", async () => {
    server.use(http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("scheduled"))));
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    await screen.findByText("Event: order.paid");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });

  it("explains the choice first, recommends reuse for a failed delivery, and sends the choice", async () => {
    let body: unknown;
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("dead"))),
      http.post(`${origin}/api/v1/deliveries/d1/replay`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { delivery_id: "d2", message_id: "m1", message_id_mode: "reuse", replay_of: "d1" },
          { status: 202 },
        );
      }),
    );
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This delivery failed");
    expect(within(dialog).getByRole("radio", { name: /Same message ID \(recommended\)/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(body).toEqual({ message_id: "reuse" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("recommends a new id for a succeeded delivery, and the choice can be changed", async () => {
    let body: unknown;
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("succeeded"))),
      http.post(`${origin}/api/v1/deliveries/d1/replay`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(
          { delivery_id: "d2", message_id: "m2", message_id_mode: "reuse", replay_of: "d1" },
          { status: 202 },
        );
      }),
    );
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /New message ID \(recommended\)/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Same message ID/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Replay" }));
    await waitFor(() => expect(body).toEqual({ message_id: "reuse" }));
  });

  it("is disabled with the date when the payload has expired, without asking the server", async () => {
    let posted = false;
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () =>
        HttpResponse.json(
          detail("dead", {
            payload: null,
            payload_expired: true,
            payload_expires_at: "2026-11-10T10:00:00.000Z",
          }),
        ),
      ),
      http.post(`${origin}/api/v1/deliveries/d1/replay`, () => {
        posted = true;
        return HttpResponse.json({});
      }),
    );
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    expect(await screen.findByRole("button", { name: "Replay" })).toBeDisabled();
    expect(screen.getByTestId("replay-expired")).toHaveTextContent(/expired on .*2026/);
    expect(posted).toBe(false);
  });

  it("turns a 410 from the server (expired meanwhile) into the disabled state with its date", async () => {
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("dead"))),
      http.post(`${origin}/api/v1/deliveries/d1/replay`, () =>
        problem(410, "replay-unavailable", "The payload has expired", {
          reason: "payload_expired",
          expired_at: "2026-11-17T09:00:00Z",
        }),
      ),
    );
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Replay" }));
    expect(await screen.findByTestId("replay-expired")).toHaveTextContent(/expired on .*2026/);
    expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
  });

  it("shows other problems in the dialog", async () => {
    server.use(
      http.get(`${origin}/api/v1/deliveries/d1`, () => HttpResponse.json(detail("dead"))),
      http.post(`${origin}/api/v1/deliveries/d1/replay`, () =>
        problem(409, "delivery-active", "Only finished deliveries can be replayed"),
      ),
    );
    await renderAs(server, "admin", <DeliveryDetailPage id="d1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Replay" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Replay" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Only finished deliveries can be replayed",
    );
  });
});

describe("bulk replay", () => {
  const counts = { replayable: 7, expired: 2, already_succeeded: 3 };

  it("is hidden from viewers", async () => {
    await renderAs(server, "viewer", <BulkReplay filters={{}} />);
    expect(screen.queryByRole("button", { name: /Bulk replay/ })).not.toBeInTheDocument();
  });

  it("shows the counts first, then replays exactly what was previewed", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${origin}/api/v1/replays`, async ({ request }) => {
        const b = (await request.json()) as Record<string, unknown>;
        bodies.push(b);
        return HttpResponse.json({ dry_run: b.dry_run, ...counts, replayed: b.dry_run ? 0 : 7 });
      }),
    );
    const EP = "11111111-1111-4111-8111-111111111111";
    await renderAs(
      server,
      "admin",
      <BulkReplay filters={{ endpoint: EP, from: "2026-11-01T00:00:00.000Z" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Bulk replay/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /^Replay/ })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    const shown = await within(dialog).findByTestId("bulk-counts");
    expect(shown).toHaveTextContent("Will be replayed7");
    expect(shown).toHaveTextContent("Payload expired, skipped2");
    expect(shown).toHaveTextContent("Already succeeded, skipped3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Replay 7" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toEqual({
      endpoint_id: EP,
      from: "2026-11-01T00:00:00.000Z",
      status: "dead",
      message_id: "reuse",
      dry_run: true,
    });
    expect(bodies[1]).toEqual({ ...bodies[0], dry_run: false });
  });

  it("drops the preview when a setting changes, so the counts must be checked again", async () => {
    server.use(
      http.post(`${origin}/api/v1/replays`, () =>
        HttpResponse.json({ dry_run: true, ...counts, replayed: 0 }),
      ),
    );
    await renderAs(server, "admin", <BulkReplay filters={{}} />);
    await userEvent.click(screen.getByRole("button", { name: /Bulk replay/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(await within(dialog).findByRole("button", { name: "Replay 7" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: /New message ID/ }));
    expect(within(dialog).queryByRole("button", { name: "Replay 7" })).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("bulk-counts")).not.toBeInTheDocument();
  });

  it("moves the recommendation with the status, from reuse for failed to new for succeeded", async () => {
    await renderAs(server, "admin", <BulkReplay filters={{}} />);
    await userEvent.click(screen.getByRole("button", { name: /Bulk replay/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Same message ID \(recommended\)/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Succeeded deliveries/ }));
    expect(within(dialog).getByRole("radio", { name: /New message ID \(recommended\)/ })).toBeChecked();
  });

  it("does not offer to replay when nothing is replayable", async () => {
    server.use(
      http.post(`${origin}/api/v1/replays`, () =>
        HttpResponse.json({ dry_run: true, replayable: 0, expired: 4, already_succeeded: 0, replayed: 0 }),
      ),
    );
    await renderAs(server, "admin", <BulkReplay filters={{}} />);
    await userEvent.click(screen.getByRole("button", { name: /Bulk replay/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(await within(dialog).findByRole("button", { name: "Replay 0" })).toBeDisabled();
  });
});
