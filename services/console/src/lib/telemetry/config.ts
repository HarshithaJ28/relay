/**
 * Browser telemetry settings, read on the server at request time so one image serves every
 * deployment: RELAY_FARO_URL (a Grafana Faro collector; unset means telemetry is off) and
 * RELAY_VERSION (reported as the app version).
 */
export interface TelemetryConfig {
  faroUrl: string | null;
  version: string;
}

export function telemetryConfig(env: Record<string, string | undefined>): TelemetryConfig {
  const raw = env.RELAY_FARO_URL?.trim();
  let faroUrl: string | null = null;
  if (raw) {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {}
    // HTTPS only, except a collector on the same machine during development.
    const local = url?.hostname === "localhost" || url?.hostname === "127.0.0.1";
    if (url && (url.protocol === "https:" || (url.protocol === "http:" && local))) faroUrl = url.href;
  }
  return { faroUrl, version: env.RELAY_VERSION?.trim() || "dev" };
}

/** Page URLs lose their query and fragment before they leave the browser. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

interface ItemLike {
  meta: { page?: { url?: string } };
  payload?: unknown;
}

/**
 * Removes query strings and fragments from what Faro sends: the page URL, and the file names
 * of stack frames (an error in inline code is reported against the page's full URL).
 */
export function scrubItem<T extends ItemLike>(item: T): T {
  const page = item.meta.page;
  const meta = page?.url ? { ...item.meta, page: { ...page, url: stripQuery(page.url) } } : item.meta;
  const payload = item.payload as { stacktrace?: { frames?: { filename?: string }[] } } | undefined;
  const frames = payload?.stacktrace?.frames;
  const scrubbedPayload = frames
    ? {
        ...payload,
        stacktrace: {
          ...payload.stacktrace,
          frames: frames.map((f) => (f.filename ? { ...f, filename: stripQuery(f.filename) } : f)),
        },
      }
    : item.payload;
  return { ...item, meta, payload: scrubbedPayload };
}
