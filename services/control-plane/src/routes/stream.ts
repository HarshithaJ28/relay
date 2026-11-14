import type { FastifyInstance } from "fastify";
import { Problem } from "../problem.js";

const HEARTBEAT_MS = 15_000;

/**
 * GET /api/v1/stream: server-sent events with the tenant's live delivery and breaker updates
 * (published by workers on relay:live:<tenant>). Authenticated with the Authorization header,
 * so the console reads it with fetch rather than EventSource (which cannot send headers and
 * would push the token into URLs and logs). A comment line every 15 s keeps proxies from
 * closing an idle stream.
 */
export async function streamRoutes(app: FastifyInstance) {
  const { subscribe } = app.deps;

  app.get("/stream", { onRequest: [app.authenticate], schema: { hide: true } }, async (request, reply) => {
    if (!subscribe) throw new Problem(503, "live-unavailable", "Live updates are not configured");
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    const unsubscribe = await subscribe(request.principal.tenantId, (json) => {
      let type = "message";
      try {
        type = (JSON.parse(json) as { type?: string }).type ?? "message";
      } catch {}
      res.write(`event: ${type}\ndata: ${json}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      void unsubscribe();
    });
  });
}
