/** RFC 9457 problem details, the error format of every Relay API. */
export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(title);
  }

  body(): Record<string, unknown> {
    return {
      type: `/problems/${this.slug}`,
      title: this.title,
      status: this.status,
      ...(this.detail ? { detail: this.detail } : {}),
      ...this.extra,
    };
  }
}

export const notFound = (what: string) => new Problem(404, "not-found", `${what} not found`);
export const forbidden = (detail?: string) => new Problem(403, "forbidden", "Not allowed", detail);
export const unauthorized = (detail?: string) =>
  new Problem(401, "unauthorized", "Authentication required", detail, {}, { "WWW-Authenticate": "Bearer" });
