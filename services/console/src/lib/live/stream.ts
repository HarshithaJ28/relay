import { SseParser } from "./parser";

/** The two event types the stream sends; see docs/stream-events.md. */
export type LiveEvent =
  | {
      type: "delivery";
      delivery_id: string;
      endpoint_id: string;
      status: string;
      attempt: number;
      error_class: string | null;
      at: number;
    }
  | { type: "breaker"; endpoint_id: string; state: "open"; until: string; at: number };

export interface StreamOptions {
  url?: string;
  /** The current access token, or null when logged out. */
  getToken: () => string | null;
  /** Called on 401: refresh the session. Resolves true if there is a new token. */
  refresh: () => Promise<boolean>;
  onEvent: (event: LiveEvent) => void;
  /** Called after a reconnect: missed events are not replayed, so refetch what is shown. */
  onReconnect: () => void;
  onStatus?: (status: "connecting" | "open" | "waiting") => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Full-jitter backoff: a random delay up to min(cap, base * 2^attempt). */
export function backoffDelay(attempt: number, base: number, cap: number, random: () => number): number {
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}

/**
 * Reads GET /api/v1/stream with fetch (EventSource cannot send the Authorization header) and
 * reconnects for ever with capped, jittered backoff until `signal` is aborted. The attempt
 * counter resets once a connection opens. Every connection after the first calls onReconnect.
 */
export async function runStream(options: StreamOptions, signal: AbortSignal): Promise<void> {
  const {
    url = "/api/v1/stream",
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
  } = options;
  let attempt = 0;
  let opened = false;
  while (!signal.aborted) {
    options.onStatus?.("connecting");
    try {
      const token = options.getToken();
      if (!token) return; // logged out: nothing to stream
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        cache: "no-store",
        signal,
      });
      if (res.status === 401) {
        if (!(await options.refresh())) return;
        continue; // a new token: try again at once
      }
      if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);
      options.onStatus?.("open");
      if (opened) options.onReconnect();
      opened = true;
      attempt = 0;
      const parser = new SseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parser.push(value)) {
          try {
            const event = JSON.parse(e.data) as LiveEvent;
            if (event.type === "delivery" || event.type === "breaker") options.onEvent(event);
          } catch {
            // a malformed event is skipped; the next refetch corrects the view
          }
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      void e;
    }
    options.onStatus?.("waiting");
    await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
    attempt += 1;
  }
}
