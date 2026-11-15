/**
 * The browser session. The access token lives only in this object's memory (never in
 * localStorage, cookies or URLs); the refresh token is an httpOnly cookie the browser sends
 * to /api/v1/auth only. On page load the app calls refresh(); a failed refresh means logged
 * out. A refresh is scheduled before the access token expires.
 *
 * Only one refresh runs at a time: every refresh rotates the refresh token, and the server
 * treats a second use of an old one as theft and revokes the whole session, so concurrent
 * callers share the refresh already in flight.
 */
export type Role = "owner" | "admin" | "viewer";

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  role: Role;
}

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: User };

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
}

export class AuthError extends Error {
  constructor(
    readonly problem: Problem,
    /** Seconds to wait before trying again (from Retry-After), when the login is locked. */
    readonly retryAfter?: number,
  ) {
    super(problem.detail ?? problem.title);
  }
}

interface SessionBody {
  access_token: string;
  expires_in: number;
  user: User;
}

export interface SessionDeps {
  fetchImpl?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Refresh one minute before expiry, or halfway for short-lived tokens. */
export function refreshDelayMs(expiresInSeconds: number): number {
  const lead = Math.min(60, expiresInSeconds / 2);
  return Math.max(0, (expiresInSeconds - lead) * 1000);
}

async function problemOf(res: Response): Promise<Problem> {
  try {
    const body = (await res.json()) as Problem;
    if (body && typeof body.title === "string") return body;
  } catch {}
  return { type: "about:blank", title: res.statusText || "Request failed", status: res.status };
}

export class Session {
  private token: string | null = null;
  private current: SessionState = { status: "loading" };
  private inFlight: Promise<boolean> | null = null;
  private timer: unknown = null;
  private readonly listeners = new Set<(s: SessionState) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(deps: SessionDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get state(): SessionState {
    return this.current;
  }

  getToken(): string | null {
    return this.token;
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Exchange the refresh cookie for a new access token. Concurrent calls share one request. */
  refresh(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.post("/api/v1/auth/login", { email, password });
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      throw new AuthError(await problemOf(res), Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    this.start((await res.json()) as SessionBody);
  }

  async register(body: { invite_code: string; tenant_name: string; email: string; password: string }) {
    const res = await this.post("/api/v1/auth/register", body);
    if (!res.ok) throw new AuthError(await problemOf(res));
    this.start((await res.json()) as SessionBody);
  }

  async logout(): Promise<void> {
    try {
      await this.post("/api/v1/auth/logout");
    } finally {
      this.end();
    }
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const res = await this.post("/api/v1/auth/refresh");
      if (!res.ok) {
        this.end();
        return false;
      }
      this.start((await res.json()) as SessionBody);
      return true;
    } catch {
      this.end();
      return false;
    }
  }

  private post(url: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method: "POST",
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private start(body: SessionBody): void {
    this.token = body.access_token;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.refresh(), refreshDelayMs(body.expires_in));
    this.set({ status: "authenticated", user: body.user });
  }

  private end(): void {
    this.token = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.set({ status: "anonymous" });
  }

  private set(state: SessionState): void {
    this.current = state;
    for (const fn of this.listeners) fn(state);
  }
}
