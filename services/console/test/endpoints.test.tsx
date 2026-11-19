import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { EndpointsPage } from "@/components/endpoints/endpoints-page";
import { Endpoint } from "@/lib/api/endpoints";
import { AuthProvider } from "@/lib/auth/context";
import { Session } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { LiveContext } from "@/lib/live/context";
import type { LiveEvent } from "@/lib/live/stream";

const origin = "http://localhost:3000";
const SECRET = `whsec_${"A".repeat(43)}`;
const EP = {
  id: "11111111-1111-4111-8111-111111111111",
  url: "https://hooks.example.com/relay",
  status: "enabled",
  concurrency_limit: 10,
  breaker_until: null,
  signing_secrets: [{ kid: "s1", expires_at: null }],
  created_at: "2026-11-01T10:00:00.000Z",
};
const problem = (status: number, slug: string, title: string, detail?: string) =>
  HttpResponse.json(
    { type: `/problems/${slug}`, title, status, ...(detail ? { detail } : {}) },
    { status, headers: { "content-type": "application/problem+json" } },
  );

const server = setupServer();
const listeners = new Set<(e: LiveEvent) => void>();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function renderAs(role: "viewer" | "admin" | "owner", list: object[] = [EP]) {
  server.use(
    http.post(`${origin}/api/v1/auth/refresh`, () =>
      HttpResponse.json({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 900,
        user: { id: "u", tenant_id: "t", email: "a@example.com", role },
      }),
    ),
    http.get(`${origin}/api/v1/endpoints`, () => HttpResponse.json(list)),
  );
  const session = new Session({ fetchImpl: (input, init) => fetch(new URL(String(input), origin), init) });
  await session.refresh();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider session={session}>
        <LiveContext.Provider
          value={{
            status: "open",
            subscribe: (fn) => {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
          }}
        >
          <EndpointsPage />
        </LiveContext.Provider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(EP.url);
  return { queryClient };
}

describe("endpoints: roles", () => {
  it("shows viewers the list without the add button or row actions", async () => {
    await renderAs("viewer");
    expect(screen.queryByRole("button", { name: /add endpoint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate secret" })).not.toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows admins the add button and every row action", async () => {
    await renderAs("admin");
    expect(screen.getByRole("button", { name: /add endpoint/i })).toBeInTheDocument();
    for (const name of ["Edit", "Disable", "Send test", "Rotate secret", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("still handles a 403 from the API with the problem and a role hint", async () => {
    await renderAs("admin");
    server.use(
      http.delete(`${origin}/api/v1/endpoints/${EP.id}`, () => problem(403, "forbidden", "Not allowed")),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your role does not allow this");
  });
});

describe("endpoints: create", () => {
  it("shows the signing secret once, then it is gone from the page and from every cache", async () => {
    const { queryClient } = await renderAs("admin");
    let sent: unknown;
    server.use(
      http.post(`${origin}/api/v1/endpoints`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...EP, id: "2", signing_secret: SECRET }, { status: 201 });
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /add endpoint/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("URL"), "https://new.example.com/hook");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByTestId("signing-secret")).toHaveTextContent(SECRET);
    expect(sent).toEqual({ url: "https://new.example.com/hook", concurrency_limit: 10 });
    await userEvent.click(screen.getByRole("button", { name: "I have saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(SECRET);
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
    expect(cached).not.toContain(SECRET);
    expect(window.location.href).not.toContain("whsec_");
  });

  it("shows a refused (SSRF) URL on the URL field, not as a general error", async () => {
    await renderAs("admin");
    server.use(
      http.post(`${origin}/api/v1/endpoints`, () =>
        problem(
          422,
          "blocked-destination",
          "Endpoint URL not allowed",
          "resolves to a private address 10.0.0.7",
        ),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /add endpoint/i }));
    const dialog = await screen.findByRole("dialog");
    const url = within(dialog).getByLabelText("URL");
    await userEvent.type(url, "https://internal.example.com/");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    await waitFor(() => expect(url).toHaveAttribute("aria-invalid", "true"));
    expect(url).toHaveAccessibleDescription("resolves to a private address 10.0.0.7");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows other problems, such as the plan limit, as a general error", async () => {
    await renderAs("admin");
    server.use(
      http.post(`${origin}/api/v1/endpoints`, () =>
        problem(409, "plan-limit", "Endpoint limit reached", "this plan allows 3 endpoints"),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /add endpoint/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("URL"), "https://new.example.com/hook");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Endpoint limit reached");
    expect(within(dialog).getByLabelText("URL")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("checks the URL before sending anything", async () => {
    await renderAs("admin");
    let called = false;
    server.use(
      http.post(`${origin}/api/v1/endpoints`, () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /add endpoint/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("URL"), "not a url");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    expect(await within(dialog).findByText(/Enter a full URL/)).toBeInTheDocument();
    expect(called).toBe(false);
  });
});

describe("endpoints: rotate", () => {
  it("explains the overlap, sends it, and shows the new secret once", async () => {
    const { queryClient } = await renderAs("admin");
    let sent: unknown;
    server.use(
      http.post(`${origin}/api/v1/endpoints/${EP.id}/rotate-secret`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ ...EP, signing_secret: SECRET });
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("switch without dropping webhooks");
    const hours = within(dialog).getByLabelText(/Keep the current secret valid/);
    await userEvent.clear(hours);
    await userEvent.type(hours, "48");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
    expect(await screen.findByTestId("signing-secret")).toHaveTextContent(SECRET);
    expect(sent).toEqual({ overlap_hours: 48 });
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain(SECRET);
  });

  it("shows a rotation already in progress as a problem", async () => {
    await renderAs("admin");
    server.use(
      http.post(`${origin}/api/v1/endpoints/${EP.id}/rotate-secret`, () =>
        problem(409, "rotation-in-progress", "A rotation is already in progress"),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A rotation is already in progress");
    expect(screen.queryByTestId("signing-secret")).not.toBeInTheDocument();
  });
});

describe("endpoints: live", () => {
  it("refetches the list when a breaker opens, so the badge changes", async () => {
    await renderAs("viewer");
    const until = new Date(Date.now() + 150 * 60_000).toISOString();
    server.use(
      http.get(`${origin}/api/v1/endpoints`, () =>
        HttpResponse.json([{ ...EP, status: "breaker_open", breaker_until: until }]),
      ),
    );
    act(() => {
      for (const fn of listeners) fn({ type: "breaker", endpoint_id: EP.id, state: "open", until, at: 1 });
    });
    expect(await screen.findByText(/Breaker open/)).toHaveTextContent("retry in 2 hours");
  });
});

describe("endpoint data", () => {
  it("the Endpoint schema strips a secret even if a response carries one", () => {
    const parsed = Endpoint.parse({ ...EP, signing_secret: SECRET });
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("shows an open breaker with when it is retried", async () => {
    await renderAs("viewer", [
      { ...EP, status: "breaker_open", breaker_until: new Date(Date.now() + 150 * 60_000).toISOString() },
    ]);
    expect(screen.getByText(/Breaker open/)).toHaveTextContent("Breaker open · retry in 2 hours");
  });

  it("formatRelative picks the largest unit that fits", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(formatRelative("2026-11-18T12:00:30Z", now)).toBe("in 30 seconds");
    expect(formatRelative("2026-11-18T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelative("2026-11-18T15:00:00Z", now)).toBe("in 3 hours");
    expect(formatRelative("2026-11-16T12:00:00Z", now)).toBe("2 days ago");
  });
});
