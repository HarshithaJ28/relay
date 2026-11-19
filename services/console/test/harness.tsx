import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { SetupServer } from "msw/node";
import type { ReactNode } from "react";
import { AuthProvider } from "@/lib/auth/context";
import { type Role, Session } from "@/lib/auth/session";
import { LiveContext } from "@/lib/live/context";
import type { LiveEvent } from "@/lib/live/stream";

export const origin = "http://localhost:3000";

export const problem = (status: number, slug: string, title: string, extra: object = {}) =>
  HttpResponse.json(
    { type: `/problems/${slug}`, title, status, ...extra },
    { status, headers: { "content-type": "application/problem+json" } },
  );

/** Render `ui` logged in as `role`, with a live context the test can emit events into. */
export async function renderAs(server: SetupServer, role: Role, ui: ReactNode) {
  server.use(
    http.post(`${origin}/api/v1/auth/refresh`, () =>
      HttpResponse.json({
        access_token: "tok",
        token_type: "Bearer",
        expires_in: 900,
        user: { id: "u", tenant_id: "t", email: "a@example.com", role },
      }),
    ),
  );
  const session = new Session({ fetchImpl: (input, init) => fetch(new URL(String(input), origin), init) });
  await session.refresh();
  const listeners = new Set<(e: LiveEvent) => void>();
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
          {ui}
        </LiveContext.Provider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { queryClient, emit: (e: LiveEvent) => listeners.forEach((fn) => void fn(e)) };
}
