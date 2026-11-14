import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { Counter, collectDefaultMetrics, Registry } from "prom-client";
import type Stripe from "stripe";
import { type Principal, type Role, verifyAccessToken } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { forbidden, Problem, unauthorized } from "./problem.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { catalogRoutes } from "./routes/catalog.js";
import { deliveryRoutes } from "./routes/deliveries.js";
import { endpointRoutes } from "./routes/endpoints.js";
import { streamRoutes } from "./routes/stream.js";
import type { Keyring } from "./secrets.js";
import type { Resolver } from "./ssrf.js";

/** Live updates for one tenant: calls onMessage per event, returns a function that unsubscribes. */
export type Subscribe = (tenantId: string, onMessage: (json: string) => void) => Promise<() => Promise<void>>;

export interface Deps {
  config: Config;
  db: Db;
  keyring: Keyring;
  resolve: Resolver;
  stripe?: Pick<Stripe, "checkout" | "webhooks">;
  subscribe?: Subscribe;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
  interface FastifyInstance {
    deps: Deps;
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireRole: (...roles: Role[]) => (request: FastifyRequest) => Promise<void>;
  }
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.RELAY_LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 256 * 1024,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate("deps", deps);
  app.decorateRequest("principal", null as unknown as Principal);

  await app.register(cookie);
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Relay control plane API", version: "1" },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });

  // ---------------------------------------------------------------- errors: always problem+json
  app.setErrorHandler(
    (error: Error & { statusCode?: number; validation?: unknown; code?: string }, request, reply) => {
      if (error instanceof Problem) {
        return reply
          .status(error.status)
          .headers(error.headers)
          .type("application/problem+json")
          .send(error.body());
      }
      if (error.validation) {
        return reply.status(422).type("application/problem+json").send({
          type: "/problems/invalid-request",
          title: "Invalid request",
          status: 422,
          detail: error.message,
        });
      }
      const status =
        error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      if (status === 500) request.log.error({ err: error }, "unhandled error");
      return reply
        .status(status)
        .type("application/problem+json")
        .send({
          type: status === 500 ? "/problems/internal" : "/problems/error",
          title: status === 500 ? "Internal error" : error.message,
          status,
        });
    },
  );
  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .type("application/problem+json")
      .send({ type: "/problems/not-found", title: "Not found", status: 404 }),
  );

  // ---------------------------------------------------------------- authentication and roles
  app.decorate("authenticate", async (request: FastifyRequest) => {
    const header = request.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) throw unauthorized();
    request.principal = await verifyAccessToken(token, deps.config.jwtSecret);
  });
  const rank: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };
  app.decorate("requireRole", (...roles: Role[]) => async (request: FastifyRequest) => {
    const needed = Math.min(...roles.map((r) => rank[r]));
    if (rank[request.principal.role] < needed) throw forbidden(`requires the ${roles.join(" or ")} role`);
  });

  // ---------------------------------------------------------------- metrics
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "relay_control_" });
  const responses = new Counter({
    name: "relay_control_requests_total",
    help: "Control-plane API responses",
    labelNames: ["route", "status"],
    registers: [registry],
  });
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url ?? "unmatched"; // a template, so ids never become labels
    if (!["/metrics", "/healthz", "/readyz"].includes(route))
      responses.inc({ route, status: reply.statusCode });
  });

  app.get("/healthz", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/readyz", { schema: { hide: true } }, async (_request, reply) => {
    try {
      await deps.db.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply
        .status(503)
        .type("application/problem+json")
        .send({ type: "/problems/unavailable", title: "Database unavailable", status: 503 });
    }
  });
  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(catalogRoutes);
      await api.register(endpointRoutes);
      await api.register(deliveryRoutes);
      await api.register(billingRoutes);
      await api.register(streamRoutes);
      api.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: "/api/v1" },
  );
  return app;
}
