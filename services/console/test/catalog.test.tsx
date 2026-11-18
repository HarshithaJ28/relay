import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { ApiKeysPage } from "@/components/catalog/api-keys-page";
import { EventTypesPage } from "@/components/catalog/event-types-page";
import { SubscriptionsPage } from "@/components/catalog/subscriptions-page";
import { UsersPage } from "@/components/catalog/users-page";
import { EVENT_TYPE } from "@/lib/api/catalog";
import { origin, problem, renderAs } from "./harness";

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const KEY = `rly_abcdef123456_${"Z".repeat(43)}`;
const key = (over: object = {}) => ({
  id: "k1",
  prefix: "abcdef123456",
  name: "production backend",
  scopes: ["events:write"],
  createdAt: "2026-11-01T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null,
  ...over,
});
const EP = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "https://hooks.example.com/relay",
  status: "enabled",
  concurrency_limit: 10,
  breaker_until: null,
  signing_secrets: [],
  created_at: "2026-11-01T00:00:00.000Z",
};

describe("pages a role cannot use", () => {
  it("show why instead of loading anything", async () => {
    let asked = false;
    server.use(
      http.get(`${origin}/api/v1/api-keys`, () => {
        asked = true;
        return HttpResponse.json([]);
      }),
      http.get(`${origin}/api/v1/users`, () => {
        asked = true;
        return HttpResponse.json([]);
      }),
    );
    await renderAs(server, "admin", <ApiKeysPage />);
    expect(await screen.findByRole("status")).toHaveTextContent("This page needs the owner role.");
    document.body.innerHTML = "";
    await renderAs(server, "viewer", <UsersPage />);
    expect(await screen.findByRole("status")).toHaveTextContent("This page needs the admin or owner role.");
    expect(asked).toBe(false);
  });
});

describe("API keys", () => {
  it("shows a new key once, then it is gone from the page and from every cache", async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(`${origin}/api/v1/api-keys`, () => HttpResponse.json(created ? [key()] : [])),
      http.post(`${origin}/api/v1/api-keys`, async ({ request }) => {
        body = await request.json();
        created = true;
        return HttpResponse.json(
          {
            id: "k1",
            key: KEY,
            prefix: "abcdef123456",
            name: "production backend",
            scopes: ["events:write"],
          },
          { status: 201 },
        );
      }),
    );
    const { queryClient } = await renderAs(server, "owner", <ApiKeysPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Create key/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Name/), "production backend");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /events:read/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await screen.findByTestId("signing-secret")).toHaveTextContent(KEY);
    expect(screen.getByRole("dialog")).toHaveTextContent("Copy this API key now");
    expect(body).toEqual({ name: "production backend", scopes: ["events:write"] });
    await userEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("rly_abcdef123456_…")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(KEY);
    const cached = JSON.stringify([
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(KEY);
  });

  it("needs at least one scope", async () => {
    server.use(http.get(`${origin}/api/v1/api-keys`, () => HttpResponse.json([])));
    await renderAs(server, "owner", <ApiKeysPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Create key/ }));
    const dialog = await screen.findByRole("dialog");
    for (const box of within(dialog).getAllByRole("checkbox")) await userEvent.click(box);
    expect(within(dialog).getByText("Choose at least one scope.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create key" })).toBeDisabled();
  });

  it("revokes after a confirmation, and a revoked key cannot be revoked again", async () => {
    let revoked = false;
    server.use(
      http.get(`${origin}/api/v1/api-keys`, () =>
        HttpResponse.json([
          key({ revokedAt: revoked ? "2026-11-18T10:00:00.000Z" : null }),
          key({ id: "k0", prefix: "000000000000", revokedAt: "2026-10-01T00:00:00.000Z" }),
        ]),
      ),
      http.delete(`${origin}/api/v1/api-keys/k1`, () => {
        revoked = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderAs(server, "owner", <ApiKeysPage />);
    expect(await screen.findAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("rly_abcdef123456_…");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument());
    expect(revoked).toBe(true);
    expect(screen.getAllByText(/^Revoked/)).toHaveLength(2);
  });
});

describe("users", () => {
  const users = [
    { id: "u", email: "a@example.com", role: "owner", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "u2", email: "b@example.com", role: "viewer", createdAt: "2026-11-02T00:00:00.000Z" },
  ];

  it("lets admins read the list but not change it", async () => {
    server.use(http.get(`${origin}/api/v1/users`, () => HttpResponse.json(users)));
    await renderAs(server, "admin", <UsersPage />);
    expect(await screen.findByText("b@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add user/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("lets owners remove others, never themselves", async () => {
    server.use(http.get(`${origin}/api/v1/users`, () => HttpResponse.json(users)));
    await renderAs(server, "owner", <UsersPage />);
    const me = (await screen.findByText("(you)")).closest("tr") as HTMLElement;
    expect(within(me).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    const other = screen.getByText("b@example.com").closest("tr") as HTMLElement;
    expect(within(other).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("adds a user, checks the password length first, and puts a taken email on the field", async () => {
    let body: unknown;
    server.use(
      http.get(`${origin}/api/v1/users`, () => HttpResponse.json(users)),
      http.post(`${origin}/api/v1/users`, async ({ request }) => {
        body = await request.json();
        return problem(409, "email-taken", "That email is already registered");
      }),
    );
    await renderAs(server, "owner", <UsersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Add user/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Relay sends no email");
    await userEvent.type(within(dialog).getByLabelText("Email"), "b@example.com");
    await userEvent.type(within(dialog).getByLabelText("Password"), "short");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
    expect(await within(dialog).findByText("At least 12 characters")).toBeInTheDocument();
    expect(body).toBeUndefined();
    await userEvent.type(within(dialog).getByLabelText("Password"), " but now long enough");
    await userEvent.selectOptions(within(dialog).getByLabelText("Role"), "admin");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add user" }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true"),
    );
    expect(within(dialog).getByText("That email is already registered")).toBeInTheDocument();
    expect(body).toEqual({ email: "b@example.com", password: "short but now long enough", role: "admin" });
  });
});

describe("event types", () => {
  it("uses the control plane's naming rule", () => {
    for (const ok of ["order.paid", "a", "Invoice:created-v2", "x_y"]) expect(EVENT_TYPE.test(ok)).toBe(true);
    for (const bad of ["", ".order", "order paid", "a/b", "é", "a".repeat(201)])
      expect(EVENT_TYPE.test(bad)).toBe(false);
  });

  it("hides the form from viewers, checks the name, and shows a duplicate on the field", async () => {
    server.use(
      http.get(`${origin}/api/v1/event-types`, () =>
        HttpResponse.json([{ id: "t1", name: "order.paid", createdAt: "2026-11-01T00:00:00.000Z" }]),
      ),
      http.post(`${origin}/api/v1/event-types`, () =>
        problem(409, "exists", "That event type already exists"),
      ),
    );
    await renderAs(server, "viewer", <EventTypesPage />);
    expect(await screen.findByText("order.paid")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add event type" })).not.toBeInTheDocument();
    document.body.innerHTML = "";
    await renderAs(server, "admin", <EventTypesPage />);
    const form = await screen.findByRole("form", { name: "Add event type" });
    await userEvent.type(within(form).getByLabelText("New event type"), "order paid");
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByText(/Start with a letter or digit/)).toBeInTheDocument();
    await userEvent.clear(within(form).getByLabelText("New event type"));
    await userEvent.type(within(form).getByLabelText("New event type"), "order.paid");
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByText("That event type already exists")).toBeInTheDocument();
    expect(within(form).getByLabelText("New event type")).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByLabelText("New event type")).toHaveAccessibleDescription(
      "That event type already exists",
    );
  });

  it("shows other problems as a general error, not on the name field", async () => {
    server.use(
      http.get(`${origin}/api/v1/event-types`, () => HttpResponse.json([])),
      http.post(`${origin}/api/v1/event-types`, () => problem(403, "forbidden", "Not allowed")),
    );
    await renderAs(server, "admin", <EventTypesPage />);
    const form = await screen.findByRole("form", { name: "Add event type" });
    await userEvent.type(within(form).getByLabelText("New event type"), "order.paid");
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Not allowed");
    expect(within(form).getByLabelText("New event type")).not.toHaveAttribute("aria-invalid", "true");
  });
});

describe("subscriptions", () => {
  const sub = { id: "s1", endpointId: EP.id, eventType: "order.paid", createdAt: "2026-11-01T00:00:00.000Z" };
  const types = [
    { id: "t1", name: "order.paid", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "t2", name: "order.refunded", createdAt: "2026-11-01T00:00:00.000Z" },
  ];

  it("shows endpoint URLs, hides changes from viewers", async () => {
    server.use(
      http.get(`${origin}/api/v1/subscriptions`, () => HttpResponse.json([sub])),
      http.get(`${origin}/api/v1/endpoints`, () => HttpResponse.json([EP])),
      http.get(`${origin}/api/v1/event-types`, () => HttpResponse.json(types)),
    );
    await renderAs(server, "viewer", <SubscriptionsPage />);
    const table = await screen.findByRole("table", { name: "Subscriptions" });
    expect(await within(table).findByText(EP.url)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add subscription" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("subscribes an endpoint to an event type and shows a duplicate as a problem", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`${origin}/api/v1/subscriptions`, () => HttpResponse.json([sub])),
      http.get(`${origin}/api/v1/endpoints`, () => HttpResponse.json([EP])),
      http.get(`${origin}/api/v1/event-types`, () => HttpResponse.json(types)),
      http.post(`${origin}/api/v1/subscriptions`, async ({ request }) => {
        bodies.push(await request.json());
        return bodies.length === 1
          ? HttpResponse.json({ id: "s2" }, { status: 201 })
          : problem(409, "exists", "Already subscribed");
      }),
    );
    await renderAs(server, "admin", <SubscriptionsPage />);
    const form = await screen.findByRole("form", { name: "Add subscription" });
    await userEvent.selectOptions(await within(form).findByLabelText("Event type"), "order.refunded");
    await userEvent.selectOptions(within(form).getByLabelText("Endpoint"), EP.id);
    await userEvent.click(within(form).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(bodies).toEqual([{ endpoint_id: EP.id, event_type: "order.refunded" }]));
    await userEvent.selectOptions(within(form).getByLabelText("Event type"), "order.paid");
    await userEvent.click(within(form).getByRole("button", { name: "Subscribe" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Already subscribed");
  });

  it("asks for an endpoint first when there is none to subscribe", async () => {
    server.use(
      http.get(`${origin}/api/v1/subscriptions`, () => HttpResponse.json([])),
      http.get(`${origin}/api/v1/endpoints`, () => HttpResponse.json([{ ...EP, status: "disabled" }])),
      http.get(`${origin}/api/v1/event-types`, () => HttpResponse.json(types)),
    );
    await renderAs(server, "admin", <SubscriptionsPage />);
    expect(await screen.findByText("To subscribe, first add an endpoint.")).toBeInTheDocument();
  });
});
