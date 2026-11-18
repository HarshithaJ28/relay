/**
 * Runs the console's end-to-end tests against the real control plane on a fresh database.
 *
 *   docker compose up -d --wait postgres valkey     (from the repository root)
 *   (cd ../control-plane && npm run build)
 *   npm run e2e                                     (or: npm run e2e -- --open)
 *
 * The console is built first with RELAY_CONTROL_PLANE_URL set: Next.js fixes rewrites at
 * build time, so a build made without it has no /api route.
 *
 * PostgreSQL (trust auth, superuser postgres) and Valkey come from RELAY_E2E_PG_HOST/PORT and
 * RELAY_E2E_VALKEY_URL, defaulting to the compose services. A database is created for the run,
 * the repository's migrations applied, and it is dropped afterwards. The control plane and
 * `next start` run as child processes; /api reaches the API through the console's rewrite, so
 * the browser sees one origin as it does behind the Ingress. No data-plane process runs:
 * deliveries stay where the control plane leaves them, and the tests seed finished ones.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(here, "..");
const controlPlane = join(consoleDir, "..", "control-plane");
const migrations = join(consoleDir, "..", "..", "db", "migrations");

const PG_HOST = process.env.RELAY_E2E_PG_HOST ?? "127.0.0.1";
const PG_PORT = Number(process.env.RELAY_E2E_PG_PORT ?? 5432);
const VALKEY = process.env.RELAY_E2E_VALKEY_URL ?? "redis://127.0.0.1:6379/14";
const API_PORT = Number(process.env.RELAY_E2E_API_PORT ?? 8181);
const WEB_PORT = Number(process.env.RELAY_E2E_WEB_PORT ?? 3200);
const DB = `relay_console_e2e_${Date.now().toString(36)}`;
const LOGIN_ROLES = ["relay_owner", "relay_control"];
// A synthetic master key, only ever used for this throwaway database.
const KEYRING = `e2e-k1:${Buffer.from([...Array(32).keys()]).toString("base64")}`;

const children = [];

async function createDatabase() {
  const admin = new pg.Client({ host: PG_HOST, port: PG_PORT, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();
  const su = new pg.Client({ host: PG_HOST, port: PG_PORT, user: "postgres", database: DB });
  await su.connect();
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const text = readFileSync(join(migrations, file), "utf8");
    await su.query(text.split("-- migrate:up")[1]?.split("-- migrate:down")[0] ?? "");
  }
  for (const role of LOGIN_ROLES) await su.query(`ALTER ROLE ${role} LOGIN`);
  await su.end();
}

async function dropDatabase() {
  const admin = new pg.Client({ host: PG_HOST, port: PG_PORT, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
}

function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  for (const s of [child.stdout, child.stderr]) s.on("data", (d) => log.push(String(d)));
  child.on("exit", (code) => {
    if (code && !child.stopping) process.stderr.write(`${name} exited with ${code}\n${log.join("")}\n`);
  });
  children.push(child);
  return child;
}

async function waitFor(url, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`${url} did not answer within ${seconds}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stopAll() {
  for (const c of children) {
    c.stopping = true;
    c.kill("SIGTERM");
  }
}

function build() {
  const r = spawnSync(
    process.execPath,
    [join(consoleDir, "node_modules", "next", "dist", "bin", "next"), "build"],
    {
      cwd: consoleDir,
      stdio: "inherit",
      env: {
        ...process.env,
        RELAY_CONTROL_PLANE_URL: `http://127.0.0.1:${API_PORT}`,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  if (r.status !== 0) throw new Error("next build failed");
}

async function main() {
  build();
  const dsn = (user) => `host=${PG_HOST} port=${PG_PORT} dbname=${DB} user=${user}`;
  await createDatabase();
  try {
    start("control plane", process.execPath, [join(controlPlane, "dist", "server.js")], {
      env: {
        ...process.env,
        RELAY_CONTROL_DSN: dsn("relay_control"),
        RELAY_JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456",
        RELAY_SECRET_KEYS: KEYRING,
        RELAY_VALKEY_URL: VALKEY,
        RELAY_CONTROL_HOST: "127.0.0.1",
        RELAY_CONTROL_PORT: String(API_PORT),
        RELAY_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}`,
        // Plain HTTP on localhost: the cookie cannot be Secure, and test endpoints are local.
        RELAY_COOKIE_SECURE: "false",
        RELAY_ALLOW_HTTP: "true",
        RELAY_ALLOW_PRIVATE_TARGETS: "true",
        RELAY_ALLOWED_PORTS: "9",
      },
    });
    start(
      "console",
      process.execPath,
      [
        join(consoleDir, "node_modules", "next", "dist", "bin", "next"),
        "start",
        "-p",
        String(WEB_PORT),
        "-H",
        "127.0.0.1",
      ],
      {
        cwd: consoleDir,
        env: { ...process.env, RELAY_CONTROL_PLANE_URL: `http://127.0.0.1:${API_PORT}` },
      },
    );
    await waitFor(`http://127.0.0.1:${API_PORT}/healthz`);
    await waitFor(`http://127.0.0.1:${WEB_PORT}/api/v1/openapi.json`);

    const mode = process.argv.includes("--open") ? "open" : "run";
    const extra = process.argv.slice(2).filter((a) => a !== "--open");
    const cypress = spawn(join(consoleDir, "node_modules", ".bin", "cypress"), [mode, ...extra], {
      cwd: consoleDir,
      stdio: "inherit",
      env: {
        ...process.env,
        CYPRESS_baseUrl: `http://127.0.0.1:${WEB_PORT}`,
        RELAY_E2E_OWNER_DSN: dsn("relay_owner"),
        RELAY_E2E_SU: JSON.stringify({ host: PG_HOST, port: PG_PORT, user: "postgres", database: DB }),
        RELAY_E2E_API: `http://127.0.0.1:${API_PORT}`,
      },
    });
    return await new Promise((resolve) => cypress.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    stopAll();
    await new Promise((r) => setTimeout(r, 500));
    await dropDatabase();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    stopAll();
    process.stderr.write(`${e.stack ?? e}\n`);
    process.exit(1);
  },
);
