import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateApiKey, KEY_PATTERN, sha256 } from "../src/apiKeys.js";
import { generateSigningSecret, Keyring, newEntry, SecretUnavailable } from "../src/secrets.js";
import {
  BlockedDestination,
  checkDestination,
  checkIp,
  checkUrl,
  type DestinationPolicy,
} from "../src/ssrf.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "tests", "fixtures");
const corpus = JSON.parse(readFileSync(join(FIXTURES, "ssrf_corpus.json"), "utf8"));
const STRICT: DestinationPolicy = { allowHttp: false, allowPrivate: false, allowedPorts: new Set([443]) };
const PRIVATE_OK: DestinationPolicy = { ...STRICT, allowPrivate: true };
const keyring = Keyring.parse(`test-k1:${Buffer.from([...Array(32).keys()]).toString("base64")}`);

describe("save-time SSRF checks (the corpus shared with the data plane)", () => {
  it.each(corpus.allowed_urls as string[])("allows %s", (url) => {
    expect(() => checkUrl(url, STRICT)).not.toThrow();
  });
  it.each(corpus.blocked_urls as string[])("blocks %s", (url) => {
    expect(() => checkUrl(url, STRICT)).toThrow(BlockedDestination);
  });
  it.each(corpus.private_ips as string[])("needs the flag for private %s", (ip) => {
    expect(() => checkIp(ip, STRICT)).toThrow(BlockedDestination);
    expect(() => checkIp(ip, PRIVATE_OK)).not.toThrow();
  });
  it.each(corpus.always_blocked_ips as string[])("never allows %s", (ip) => {
    expect(() => checkIp(ip, PRIVATE_OK)).toThrow(BlockedDestination);
  });
  it.each(corpus.public_ips as string[])("allows public %s", (ip) => {
    expect(() => checkIp(ip, STRICT)).not.toThrow();
  });

  it("checks every address the host resolves to", async () => {
    const answers = async () => ["93.184.215.14", "10.0.0.7"];
    await expect(checkDestination("https://example.com/hook", STRICT, answers)).rejects.toThrow(/private/);
    await expect(checkDestination("https://example.com/hook", STRICT, async () => [])).rejects.toThrow(
      /resolve/,
    );
    await expect(
      checkDestination("https://example.com/hook", STRICT, async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/resolve/);
    await expect(
      checkDestination("https://example.com/hook", STRICT, async () => ["93.184.215.14"]),
    ).resolves.toMatchObject({
      host: "example.com",
      port: 443,
    });
  });
});

describe("signing secrets (same scheme as the data plane)", () => {
  const vectors = JSON.parse(readFileSync(join(FIXTURES, "secret_vectors.json"), "utf8"));

  it("decrypts what the Python data plane encrypted, and its own", () => {
    for (const origin of ["from_python", "from_typescript"]) {
      expect(keyring.decrypt(vectors.endpoint_id, vectors[origin].entry)).toBe(vectors[origin].plaintext);
    }
  });

  it("binds a ciphertext to its endpoint and secret id, and rejects tampering", () => {
    const entry = newEntry(keyring, "ep-1", "s1", "whsec_x");
    expect(keyring.decrypt("ep-1", entry)).toBe("whsec_x");
    expect(() => keyring.decrypt("ep-2", entry)).toThrow(SecretUnavailable);
    expect(() => keyring.decrypt("ep-1", { ...entry, kid: "s2" })).toThrow(SecretUnavailable);
    const raw = Buffer.from(entry.ciphertext, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    expect(() => keyring.decrypt("ep-1", { ...entry, ciphertext: raw.toString("base64") })).toThrow(
      SecretUnavailable,
    );
    expect(() => keyring.decrypt("ep-1", { ...entry, key_id: "gone" })).toThrow(SecretUnavailable);
  });

  it("parses keyrings like the data plane and never prints keys", () => {
    const k2 = Buffer.alloc(32, 7).toString("base64");
    const ring = Keyring.parse(
      `# rotated\nk2:${k2}\ntest-k1:${Buffer.from([...Array(32).keys()]).toString("base64")}`,
    );
    expect(ring.current).toBe("k2");
    expect(String(ring)).not.toContain(k2);
    for (const bad of ["", "k1", `k1:${Buffer.alloc(8).toString("base64")}`, "k1:@@@", `k1:${k2},k1:${k2}`]) {
      expect(() => Keyring.parse(bad)).toThrow();
    }
  });

  it("generates Standard Webhooks secrets", () => {
    const s = generateSigningSecret();
    expect(s).toMatch(/^whsec_/);
    expect(Buffer.from(s.slice(6), "base64")).toHaveLength(32);
  });
});

describe("API keys", () => {
  it("match the data plane's format and are stored only as a hash", () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(KEY_PATTERN);
    expect(key.startsWith(`rly_${prefix}_`)).toBe(true);
    expect(sha256(key)).toHaveLength(32);
    expect(generateApiKey().key).not.toBe(key);
  });
});

describe("OpenAPI", () => {
  it("documents every public route", async () => {
    const { makeApp } = await import("./helpers.js");
    const app = await makeApp();
    const doc = (await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    const paths = Object.keys(doc.paths);
    for (const p of [
      "/api/v1/auth/register",
      "/api/v1/auth/login",
      "/api/v1/auth/refresh",
      "/api/v1/endpoints",
      "/api/v1/endpoints/{id}/rotate-secret",
      "/api/v1/subscriptions",
      "/api/v1/api-keys",
      "/api/v1/deliveries",
      "/api/v1/deliveries/{id}/replay",
      "/api/v1/replays",
      "/api/v1/usage",
      "/api/v1/billing/checkout-session",
    ]) {
      expect(paths, p).toContain(p);
    }
    expect(doc.openapi).toBe("3.1.0");
  });
});
