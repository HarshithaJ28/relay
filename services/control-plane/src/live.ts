import { Valkey } from "iovalkey";
import type { Subscribe } from "./app.js";

/** One Valkey connection in subscriber mode, shared by every open stream. */
export function valkeySubscriber(url: string): Subscribe {
  const client = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: null });
  const listeners = new Map<string, Set<(json: string) => void>>();
  client.on("message", (channel: string, message: string) => {
    for (const listener of listeners.get(channel) ?? []) listener(message);
  });
  client.on("error", () => {}); // reconnects on its own; streams simply see no events meanwhile
  let connected: Promise<void> | undefined;
  return async (tenantId, onMessage) => {
    connected ??= client.connect();
    await connected;
    const channel = `relay:live:${tenantId}`;
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
      await client.subscribe(channel);
    }
    set.add(onMessage);
    return async () => {
      set.delete(onMessage);
      if (set.size === 0) {
        listeners.delete(channel);
        await client.unsubscribe(channel).catch(() => {});
      }
    };
  };
}
