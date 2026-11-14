import { randomBytes } from "node:crypto";
import { sha256 } from "./apiKeys.js";

/** Invite codes: rinv_ followed by 32 random bytes in URL-safe base64. Only the SHA-256 is stored. */
export const INVITE_PATTERN = /^rinv_[A-Za-z0-9_-]{43}$/;

export function generateInvite(): string {
  return `rinv_${randomBytes(32).toString("base64url")}`;
}

export const inviteHash = (code: string) => sha256(code);
