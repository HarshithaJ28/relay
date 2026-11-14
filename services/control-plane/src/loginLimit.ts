/**
 * Login throttling (A1), kept in Valkey so every control-plane replica shares it.
 *
 * Failed logins are counted per client IP and per account (the email, hashed so no address
 * is stored in Valkey). When either count reaches its limit inside the window, that IP or
 * account is locked for lockSeconds: every login for it gets 429 with Retry-After, even
 * with the right password, and the password is not checked. A successful login clears the
 * account's count, not the IP's.
 *
 * The account lock works the same for emails that do not exist, so it reveals nothing.
 * If Valkey cannot be reached, login fails with 503 rather than running unthrottled.
 */
import { Valkey } from "iovalkey";
import { sha256 } from "./apiKeys.js";

export interface LoginLimits {
  maxPerAccount: number;
  maxPerIp: number;
  /** Both the counting window and the lock length. */
  lockSeconds: number;
}

export interface LoginLimiter {
  /** Seconds until this IP and account may try again; 0 when neither is locked. */
  retryAfter(ip: string, email: string): Promise<number>;
  recordFailure(ip: string, email: string): Promise<void>;
  recordSuccess(email: string): Promise<void>;
  close(): Promise<void>;
}

// KEYS[1] failure counter, KEYS[2] lock. ARGV: window/lock ms, limit.
const FAIL = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if n >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
  redis.call('DEL', KEYS[1])
end
return n`;

export class LimiterUnavailable extends Error {}

export function valkeyLoginLimiter(url: string, limits: LoginLimits, prefix = "relay:login"): LoginLimiter {
  // No offline queue: while Valkey is down, calls fail at once instead of waiting.
  const client = new Valkey(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  client.on("error", () => {}); // reconnects on its own; calls fail meanwhile (503)
  let connected: Promise<void> | undefined;
  const ready = async () => {
    try {
      connected ??= client.connect();
      await connected;
    } catch (e) {
      connected = undefined;
      throw new LimiterUnavailable((e as Error).message);
    }
  };
  const account = (email: string) => sha256(email.trim().toLowerCase()).toString("hex");
  const keys = (ip: string, email: string) => ({
    ipCount: `${prefix}:ip:${ip}:n`,
    ipLock: `${prefix}:ip:${ip}:lock`,
    accountCount: `${prefix}:acct:${account(email)}:n`,
    accountLock: `${prefix}:acct:${account(email)}:lock`,
  });
  const lockMs = String(limits.lockSeconds * 1000);
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    await ready();
    try {
      return await fn();
    } catch (e) {
      throw new LimiterUnavailable((e as Error).message);
    }
  };

  return {
    retryAfter: (ip, email) =>
      guard(async () => {
        const k = keys(ip, email);
        const [a, b] = await Promise.all([client.pttl(k.ipLock), client.pttl(k.accountLock)]);
        const ms = Math.max(a, b);
        return ms > 0 ? Math.ceil(ms / 1000) : 0;
      }),
    recordFailure: (ip, email) =>
      guard(async () => {
        const k = keys(ip, email);
        await client.eval(FAIL, 2, k.ipCount, k.ipLock, lockMs, String(limits.maxPerIp));
        await client.eval(FAIL, 2, k.accountCount, k.accountLock, lockMs, String(limits.maxPerAccount));
      }),
    recordSuccess: (email) =>
      guard(async () => {
        await client.del(keys("", email).accountCount);
      }),
    close: async () => {
      client.disconnect();
    },
  };
}
