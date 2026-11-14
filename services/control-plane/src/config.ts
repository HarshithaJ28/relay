import { readFileSync } from "node:fs";
import { z } from "zod";

const flagValues = z.enum(["", "0", "1", "true", "false", "yes", "no"]);
const truthy = (v: string) => v === "1" || v === "true" || v === "yes";
const flag = flagValues.default("").transform(truthy);
const flagOn = flagValues.default("true").transform(truthy);

const EnvSchema = z.object({
  RELAY_CONTROL_DSN: z.string().min(1, "RELAY_CONTROL_DSN is required (connect as relay_control)"),
  RELAY_JWT_SECRET: z.string().min(32, "RELAY_JWT_SECRET must be at least 32 characters"),
  RELAY_SECRET_KEYS: z.string().optional(),
  RELAY_SECRET_KEYS_FILE: z.string().optional(),
  RELAY_VALKEY_URL: z.string().min(1, "RELAY_VALKEY_URL is required (login throttling and live updates)"),
  RELAY_PUBLIC_URL: z.string().url().default("http://localhost:8081"),
  RELAY_CONTROL_HOST: z.string().default("0.0.0.0"),
  RELAY_CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  RELAY_COOKIE_SECURE: flagOn,
  RELAY_ACCESS_TOKEN_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  RELAY_REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  RELAY_LOGIN_MAX_FAILURES_PER_ACCOUNT: z.coerce.number().int().min(1).max(100).default(5),
  RELAY_LOGIN_MAX_FAILURES_PER_IP: z.coerce.number().int().min(1).max(10_000).default(20),
  RELAY_LOGIN_LOCK_SECONDS: z.coerce.number().int().min(1).max(86_400).default(900),
  RELAY_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RELAY_ALLOW_HTTP: flag,
  RELAY_ALLOW_PRIVATE_TARGETS: flag,
  RELAY_ALLOWED_PORTS: z.string().default(""),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
});

export interface Config {
  dsn: string;
  jwtSecret: Uint8Array;
  keyring: string;
  valkeyUrl: string;
  login: { maxPerAccount: number; maxPerIp: number; lockSeconds: number };
  /** Reverse proxies in front of the API whose X-Forwarded-For is believed (0: none). */
  trustedProxyHops: number;
  publicUrl: string;
  host: string;
  port: number;
  cookieSecure: boolean;
  accessTokenSeconds: number;
  refreshTokenDays: number;
  destination: { allowHttp: boolean; allowPrivate: boolean; allowedPorts: Set<number> };
  stripe: { secretKey?: string; webhookSecret?: string; pricePro?: string };
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const e = parsed.data;
  if (Boolean(e.RELAY_SECRET_KEYS) === Boolean(e.RELAY_SECRET_KEYS_FILE)) {
    throw new ConfigError("set exactly one of RELAY_SECRET_KEYS and RELAY_SECRET_KEYS_FILE");
  }
  const keyring = e.RELAY_SECRET_KEYS ?? readFileSync(e.RELAY_SECRET_KEYS_FILE as string, "utf8");
  const ports = e.RELAY_ALLOWED_PORTS.trim()
    ? new Set(e.RELAY_ALLOWED_PORTS.split(",").map((p) => Number(p.trim())))
    : new Set(e.RELAY_ALLOW_HTTP ? [80, 443] : [443]);
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new ConfigError("RELAY_ALLOWED_PORTS must list ports between 1 and 65535");
    }
  }
  return {
    dsn: e.RELAY_CONTROL_DSN,
    jwtSecret: new TextEncoder().encode(e.RELAY_JWT_SECRET),
    keyring,
    valkeyUrl: e.RELAY_VALKEY_URL,
    login: {
      maxPerAccount: e.RELAY_LOGIN_MAX_FAILURES_PER_ACCOUNT,
      maxPerIp: e.RELAY_LOGIN_MAX_FAILURES_PER_IP,
      lockSeconds: e.RELAY_LOGIN_LOCK_SECONDS,
    },
    trustedProxyHops: e.RELAY_TRUSTED_PROXY_HOPS,
    publicUrl: e.RELAY_PUBLIC_URL.replace(/\/$/, ""),
    host: e.RELAY_CONTROL_HOST,
    port: e.RELAY_CONTROL_PORT,
    cookieSecure: e.RELAY_COOKIE_SECURE,
    accessTokenSeconds: e.RELAY_ACCESS_TOKEN_SECONDS,
    refreshTokenDays: e.RELAY_REFRESH_TOKEN_DAYS,
    destination: {
      allowHttp: e.RELAY_ALLOW_HTTP,
      allowPrivate: e.RELAY_ALLOW_PRIVATE_TARGETS,
      allowedPorts: ports,
    },
    stripe: {
      ...(e.STRIPE_SECRET_KEY ? { secretKey: e.STRIPE_SECRET_KEY } : {}),
      ...(e.STRIPE_WEBHOOK_SECRET ? { webhookSecret: e.STRIPE_WEBHOOK_SECRET } : {}),
      ...(e.STRIPE_PRICE_PRO ? { pricePro: e.STRIPE_PRICE_PRO } : {}),
    },
  };
}
