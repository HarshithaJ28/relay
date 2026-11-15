import createClient from "openapi-fetch";
import type { Session } from "../auth/session";
import { isProblem, ProblemError } from "./problem";
import type { paths } from "./schema";

/**
 * The typed control-plane client (types generated from /api/v1/openapi.json). It adds the
 * in-memory access token, and on a 401 refreshes the session once and retries the request.
 */
export function createApi(
  session: Session,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  // Same origin as the page (Traefik routes /api to the control plane).
  baseUrl: string = globalThis.location?.origin ?? "",
) {
  const authed: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const send = (token: string | null) => {
      const r = request.clone();
      if (token) r.headers.set("authorization", `Bearer ${token}`);
      return fetchImpl(r);
    };
    const res = await send(session.getToken());
    if (res.status !== 401 || session.getToken() === null) return res;
    return (await session.refresh()) ? send(session.getToken()) : res;
  };
  return createClient<paths>({ baseUrl, fetch: authed });
}

export type Api = ReturnType<typeof createApi>;

/** Unwrap an openapi-fetch result: the data, or a thrown ProblemError. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const e = result.error;
    throw new ProblemError(
      isProblem(e)
        ? e
        : { type: "about:blank", title: result.response.statusText, status: result.response.status },
    );
  }
  return result.data as T;
}
