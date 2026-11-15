import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { LoginForm } from "@/components/login-form";
import { NAV } from "@/components/shell/nav";
import { AuthProvider } from "@/lib/auth/context";
import { can } from "@/lib/auth/roles";
import { Session } from "@/lib/auth/session";

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const origin = "http://localhost";
function wrap(ui: ReactNode, session: Session) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider session={session}>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}
const testSession = () =>
  new Session({ fetchImpl: (input, init) => fetch(new URL(String(input), origin), init) });

describe("LoginForm", () => {
  it("validates before sending anything", async () => {
    server.use(http.post(`${origin}/api/v1/auth/refresh`, () => HttpResponse.json({}, { status: 401 })));
    wrap(<LoginForm onSuccess={() => {}} />, testSession());
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter an email address")).toBeInTheDocument();
  });

  it("shows the problem and a countdown when the login is locked, and disables the button", async () => {
    server.use(
      http.post(`${origin}/api/v1/auth/refresh`, () => HttpResponse.json({}, { status: 401 })),
      http.post(`${origin}/api/v1/auth/login`, () =>
        HttpResponse.json(
          {
            type: "/problems/too-many-attempts",
            title: "Too many failed logins",
            status: 429,
            detail: "Try again later.",
          },
          { status: 429, headers: { "retry-after": "840", "content-type": "application/problem+json" } },
        ),
      ),
    );
    wrap(<LoginForm onSuccess={() => {}} />, testSession());
    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many failed logins");
    expect(screen.getByRole("status")).toHaveTextContent("Try again in 14 minutes");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("calls onSuccess after a good login", async () => {
    const user = { id: "u", tenant_id: "t", email: "a@example.com", role: "viewer" };
    server.use(
      http.post(`${origin}/api/v1/auth/refresh`, () => HttpResponse.json({}, { status: 401 })),
      http.post(`${origin}/api/v1/auth/login`, () =>
        HttpResponse.json({ access_token: "t", token_type: "Bearer", expires_in: 900, user }),
      ),
    );
    const onSuccess = vi.fn();
    wrap(<LoginForm onSuccess={onSuccess} />, testSession());
    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "right password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });
});

describe("navigation by role", () => {
  const labels = (role: "viewer" | "admin" | "owner") =>
    NAV.filter((i) => !i.action || can(role, i.action)).map((i) => i.label);
  it("hides API keys and users from viewers, and API keys from admins", () => {
    expect(labels("viewer")).not.toContain("API keys");
    expect(labels("viewer")).not.toContain("Users");
    expect(labels("admin")).toContain("Users");
    expect(labels("admin")).not.toContain("API keys");
    expect(labels("owner")).toEqual(NAV.map((i) => i.label));
  });
});
