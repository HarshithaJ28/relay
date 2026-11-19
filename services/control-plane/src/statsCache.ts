/**
 * A small JSON cache in Valkey for GET /api/v1/stats (30 s by default). It is only a cache:
 * if Valkey cannot be reached, stats are computed from the database instead.
 */
import { Valkey } from "iovalkey";

export interface JsonCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export function valkeyJsonCache(url: string, ttlSeconds = 30, prefix = "relay:stats"): JsonCache {
  const client = new Valkey(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  client.on("error", () => {});
  let connected: Promise<void> | undefined;
  const ready = async () => {
    connected ??= client.connect().catch((e) => {
      connected = undefined;
      throw e;
    });
    await connected;
  };
  return {
    async get(key) {
      await ready();
      const text = await client.get(`${prefix}:${key}`);
      return text === null ? undefined : JSON.parse(text);
    },
    async set(key, value) {
      await ready();
      await client.set(`${prefix}:${key}`, JSON.stringify(value), "EX", ttlSeconds);
    },
    async close() {
      client.disconnect();
    },
  };
}
