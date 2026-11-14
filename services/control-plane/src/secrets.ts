/**
 * Endpoint signing secrets, encrypted at rest with AES-256-GCM.
 *
 * Byte-for-byte the same scheme as the data plane (relay_dataplane/endpoint_secrets.py), so
 * either side can read what the other wrote: the keyring is "id:base64key" entries (the first
 * encrypts), each ciphertext is base64(nonce || ciphertext || tag) bound to its endpoint and
 * secret id through the associated data, and plaintext secrets never reach the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const AAD_PREFIX = "relay:endpoint-signing-secret:v1";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretEntry {
  kid: string;
  key_id: string;
  ciphertext: string;
  expires_at: string | null;
}

export class SecretUnavailable extends Error {}

export class Keyring {
  readonly current: string;
  private readonly keys: Map<string, Buffer>;

  constructor(keys: Map<string, Buffer>, current: string) {
    if (!keys.has(current)) throw new Error("current key id is not in the keyring");
    for (const [id, key] of keys) {
      if (!KEY_ID.test(id)) throw new Error(`invalid key id ${JSON.stringify(id)}`);
      if (key.length !== 32) throw new Error(`key ${JSON.stringify(id)} must be 32 bytes`);
    }
    this.keys = keys;
    this.current = current;
  }

  static parse(text: string): Keyring {
    const keys = new Map<string, Buffer>();
    let first: string | undefined;
    for (const raw of text.split(/[,\n]/)) {
      const item = raw.trim();
      if (!item || item.startsWith("#")) continue;
      const sep = item.indexOf(":");
      if (sep < 0) throw new Error("keyring entries must look like id:base64key");
      const id = item.slice(0, sep);
      const encoded = item.slice(sep + 1).trim();
      if (keys.has(id)) throw new Error(`duplicate key id ${JSON.stringify(id)}`);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`key ${JSON.stringify(id)} is not base64`);
      keys.set(id, Buffer.from(encoded, "base64"));
      first ??= id;
    }
    if (first === undefined) throw new Error("keyring is empty");
    return new Keyring(keys, first);
  }

  toString(): string {
    return `Keyring(current=${this.current})`; // never print key material
  }

  encrypt(endpointId: string, kid: string, plaintext: string): Omit<SecretEntry, "expires_at"> {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.current) as Buffer, nonce);
    cipher.setAAD(aad(endpointId, kid));
    const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { kid, key_id: this.current, ciphertext: Buffer.concat([nonce, sealed]).toString("base64") };
  }

  decrypt(endpointId: string, entry: Partial<SecretEntry>): string {
    const { kid, key_id: keyId, ciphertext } = entry;
    if (typeof kid !== "string" || typeof keyId !== "string" || typeof ciphertext !== "string") {
      throw new SecretUnavailable("malformed secret entry");
    }
    const key = this.keys.get(keyId);
    if (!key) throw new SecretUnavailable(`secret ${kid} uses unknown master key ${keyId}`);
    const raw = Buffer.from(ciphertext, "base64");
    if (raw.length <= NONCE_BYTES + TAG_BYTES) throw new SecretUnavailable(`secret ${kid} does not decrypt`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
      decipher.setAAD(aad(endpointId, kid));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretUnavailable(`secret ${kid} does not decrypt`);
    }
  }
}

function aad(endpointId: string, kid: string): Buffer {
  return Buffer.from([AAD_PREFIX, endpointId, kid].join("\0"), "utf8");
}

/** A new Standard Webhooks secret: whsec_ + base64 of 32 random bytes. */
export function generateSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export function newEntry(
  keyring: Keyring,
  endpointId: string,
  kid: string,
  secret: string,
  expiresAt: Date | null = null,
): SecretEntry {
  return {
    ...keyring.encrypt(endpointId, kid, secret),
    expires_at: expiresAt ? expiresAt.toISOString() : null,
  };
}
