/**
 * Accounts and sessions.
 *
 * - Passwords: argon2id (OWASP parameters). Login for an unknown email verifies against a
 *   fixed dummy hash, so response time does not reveal which emails exist.
 * - Access token: a short-lived HS256 JWT (sub = user, tid = tenant, role) sent in the
 *   Authorization header. The console keeps it in memory, never in storage.
 * - Refresh token: 32 random bytes, stored only as SHA-256, in an httpOnly, SameSite=Strict
 *   cookie limited to /api/v1/auth. Each use rotates it; reusing an old one revokes the
 *   whole session family (control.rotate_session).
 */
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { jwtVerify, SignJWT } from "jose";
import { sha256 } from "./apiKeys.js";
import { unauthorized } from "./problem.js";

export type Role = "owner" | "admin" | "viewer";

export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
}

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const ISSUER = "relay";
const AUDIENCE = "relay-console";
export const REFRESH_COOKIE = "relay_refresh";

export const hashPassword = (password: string) => hash(password, ARGON2);

let dummyHash: Promise<string> | undefined;

/** Constant-work password check: an unknown user costs the same as a wrong password. */
export async function passwordMatches(stored: string | undefined, password: string): Promise<boolean> {
  if (stored === undefined) {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    await verify(await dummyHash, password);
    return false;
  }
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

export async function issueAccessToken(p: Principal, secret: Uint8Array, seconds: number): Promise<string> {
  return new SignJWT({ tid: p.tenantId, role: p.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(p.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string, secret: Uint8Array): Promise<Principal> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      clockTolerance: 5,
    });
    const role = payload.role;
    if (typeof payload.sub !== "string" || typeof payload.tid !== "string" || !isRole(role)) {
      throw new Error("claims");
    }
    return { userId: payload.sub, tenantId: payload.tid, role };
  } catch {
    throw unauthorized("invalid or expired access token");
  }
}

const isRole = (r: unknown): r is Role => r === "owner" || r === "admin" || r === "viewer";

export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export const refreshHash = (token: string) => sha256(token);
