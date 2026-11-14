import Stripe from "stripe";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { valkeySubscriber } from "./live.js";
import { Keyring } from "./secrets.js";
import { systemResolver } from "./ssrf.js";

async function main(): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  let keyring: Keyring;
  try {
    config = loadConfig();
    keyring = Keyring.parse(config.keyring);
  } catch (e) {
    process.stderr.write(`configuration error: ${(e as Error).message}\n`);
    return 2;
  }
  const db = createPool(config.dsn);
  const app = await buildApp({
    config,
    db,
    keyring,
    resolve: systemResolver,
    ...(config.stripe.secretKey ? { stripe: new Stripe(config.stripe.secretKey) } : {}),
    ...(config.valkeyUrl ? { subscribe: valkeySubscriber(config.valkeyUrl) } : {}),
  });
  const stop = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close(); // stops accepting, waits for requests in progress
    await db.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  await app.listen({ host: config.host, port: config.port });
  return -1; // keep running
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  },
);
