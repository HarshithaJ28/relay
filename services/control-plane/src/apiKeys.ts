/**
 * Ingestion API keys: rly_<12 hex prefix>_<43 base64url chars>. Same format and hash as the
 * data plane (relay_dataplane/api_keys.py), which authenticates them. Only the SHA-256 of the
 * whole key is stored; the key is shown once.
 */
import { createHash, randomBytes } from "node:crypto";

export const KEY_PATTERN = /^rly_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
export const SCOPES = ["events:write", "events:read"] as const;

export function generateApiKey(): { key: string; prefix: string } {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { key: `rly_${prefix}_${secret}`, prefix };
}

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest();
