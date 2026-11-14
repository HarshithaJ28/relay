import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  hashPassword,
  issueAccessToken,
  newRefreshToken,
  type Principal,
  passwordMatches,
  REFRESH_COOKIE,
  type Role,
  refreshHash,
} from "../auth.js";
import { withoutTenant, withTenant } from "../db.js";
import { Problem, unauthorized } from "../problem.js";
import { ProblemSchema } from "./shared.js";

const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "invalid email");
const Password = z.string().min(12, "at least 12 characters").max(200);
const Session = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  user: z.object({
    id: z.string().uuid(),
    tenant_id: z.string().uuid(),
    email: z.string(),
    role: z.string(),
  }),
});

export async function authRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { config, db } = app.deps;
  const refreshTtl = `${config.refreshTokenDays} days`;

  async function startSession(reply: FastifyReply, p: Principal, email: string) {
    const refresh = newRefreshToken();
    await withoutTenant(db, (tx) =>
      tx.query("SELECT control.start_session($1, $2, $3::interval)", [p.userId, refresh.hash, refreshTtl]),
    );
    setRefreshCookie(reply, refresh.token);
    return sessionBody(p, email);
  }

  function setRefreshCookie(reply: FastifyReply, token: string) {
    reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/api/v1/auth",
      maxAge: config.refreshTokenDays * 86_400,
    });
  }

  async function sessionBody(p: Principal, email: string) {
    return {
      access_token: await issueAccessToken(p, config.jwtSecret, config.accessTokenSeconds),
      token_type: "Bearer" as const,
      expires_in: config.accessTokenSeconds,
      user: { id: p.userId, tenant_id: p.tenantId, email, role: p.role },
    };
  }

  api.post(
    "/auth/register",
    {
      schema: {
        security: [],
        body: z.object({ tenant_name: z.string().trim().min(1).max(200), email: Email, password: Password }),
        response: { 201: Session, 409: ProblemSchema, 422: ProblemSchema },
      },
    },
    async (request, reply) => {
      const { tenant_name, email, password } = request.body;
      const passwordHash = await hashPassword(password);
      let row: { o_tenant_id: string; o_user_id: string };
      try {
        row = await withoutTenant(db, async (tx) => {
          const r = await tx.query("SELECT * FROM control.register_tenant($1, $2, $3)", [
            tenant_name,
            email,
            passwordHash,
          ]);
          return r.rows[0];
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new Problem(409, "email-taken", "That email is already registered");
        throw e;
      }
      const body = await startSession(
        reply,
        { userId: row.o_user_id, tenantId: row.o_tenant_id, role: "owner" },
        email,
      );
      return reply.status(201).send(body);
    },
  );

  api.post(
    "/auth/login",
    {
      schema: {
        security: [],
        body: z.object({ email: Email, password: z.string().max(200) }),
        response: { 200: Session, 401: ProblemSchema },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await withoutTenant(db, async (tx) => {
        const r = await tx.query("SELECT * FROM control.user_for_login($1)", [email]);
        return r.rows[0] as
          | { o_user_id: string; o_tenant_id: string; o_password_hash: string; o_role: Role }
          | undefined;
      });
      // Same work and the same answer whether the email or the password was wrong.
      if (!(await passwordMatches(user?.o_password_hash, password)) || !user) {
        throw unauthorized("wrong email or password");
      }
      return reply.send(
        await startSession(
          reply,
          { userId: user.o_user_id, tenantId: user.o_tenant_id, role: user.o_role },
          email,
        ),
      );
    },
  );

  api.post(
    "/auth/refresh",
    { schema: { security: [], response: { 200: Session, 401: ProblemSchema } } },
    async (request, reply) => {
      const old = request.cookies[REFRESH_COOKIE];
      if (!old) throw unauthorized("no session");
      const next = newRefreshToken();
      const row = await withoutTenant(db, async (tx) => {
        const r = await tx.query("SELECT * FROM control.rotate_session($1, $2, $3::interval)", [
          refreshHash(old),
          next.hash,
          refreshTtl,
        ]);
        return r.rows[0] as { o_user_id: string; o_tenant_id: string; o_role: Role } | undefined;
      });
      if (!row) {
        reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
        throw unauthorized("session expired or revoked");
      }
      setRefreshCookie(reply, next.token);
      const p = { userId: row.o_user_id, tenantId: row.o_tenant_id, role: row.o_role };
      const email = await withTenant(db, p.tenantId, async (tx) => {
        const r = await tx.query("SELECT email FROM control.users WHERE id = $1", [p.userId]);
        return r.rows[0]?.email as string;
      });
      return reply.send(await sessionBody(p, email));
    },
  );

  api.post(
    "/auth/logout",
    { schema: { security: [], response: { 204: z.null() } } },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (token)
        await withoutTenant(db, (tx) => tx.query("SELECT control.end_session($1)", [refreshHash(token)]));
      reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
      return reply.status(204).send(null);
    },
  );

  api.get(
    "/me",
    { onRequest: [app.authenticate], schema: { response: { 200: Session.shape.user, 401: ProblemSchema } } },
    async (request) => {
      const p = request.principal;
      return withTenant(db, p.tenantId, async (tx) => {
        const r = await tx.query("SELECT id, tenant_id, email, role FROM control.users WHERE id = $1", [
          p.userId,
        ]);
        if (!r.rows[0]) throw unauthorized("user no longer exists");
        return r.rows[0];
      });
    },
  );
}
