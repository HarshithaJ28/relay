import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "cypress";
import pg from "pg";

type CreateInvite = (dsn: string, days: number, note: string) => Promise<string>;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: run the tests with npm run e2e`);
  return v;
}

export default defineConfig({
  video: false,
  screenshotOnRunFailure: true,
  retries: 0,
  e2e: {
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    viewportWidth: 1280,
    viewportHeight: 900,
    setupNodeEvents(on) {
      on("task", {
        /** A new tenant through an operator invite; returns its owner's credentials. */
        async tenant() {
          // The operator's own invite function, so tenants are made exactly as in production.
          const cli = pathToFileURL(join(process.cwd(), "..", "control-plane", "dist", "cli.js")).href;
          const { createInvite } = (await import(cli)) as { createInvite: CreateInvite };
          const code = await createInvite(env("RELAY_E2E_OWNER_DSN"), 1, "console e2e");
          const email = `owner-${randomUUID()}@example.com`;
          const password = "correct horse battery staple";
          const r = await fetch(`${env("RELAY_E2E_API")}/api/v1/auth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ invite_code: code, tenant_name: "E2E tenant", email, password }),
          });
          if (r.status !== 201) throw new Error(`register: ${r.status} ${await r.text()}`);
          return { email, password };
        },
        /** Marks a delivery dead, as the worker would after its last attempt. */
        async finishDelivery(id: string) {
          const su = new pg.Client(JSON.parse(env("RELAY_E2E_SU")));
          await su.connect();
          try {
            const r = await su.query(
              "UPDATE delivery.deliveries SET status = 'dead', last_error_class = 'max_attempts' WHERE id = $1",
              [id],
            );
            if (r.rowCount !== 1) throw new Error(`no delivery ${id}`);
          } finally {
            await su.end();
          }
          return null;
        },
      });
    },
  },
});
