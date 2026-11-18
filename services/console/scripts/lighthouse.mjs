/**
 * Lighthouse on the production build of the console, signed in, against the real control plane.
 * Run through the stack runner, which starts everything on a fresh database:
 *
 *   npm run lighthouse
 *
 * Each page is audited three times with Lighthouse's default mobile settings (emulated phone,
 * simulated slow 4G and CPU slow-down) and the median score per category is compared with
 * scripts/lighthouse-thresholds.json. HTML and JSON reports go to lighthouse-results/.
 * RELAY_LH_PAGES=/login,/endpoints audits only those pages.
 *
 * Signed-in pages need the refresh cookie. Refresh tokens are single use (a reused one ends
 * the session), so every audit signs in again and sends its own fresh cookie.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const WEB = process.env.RELAY_E2E_WEB;
const API = process.env.RELAY_E2E_API;
const OWNER_DSN = process.env.RELAY_E2E_OWNER_DSN;
if (!WEB || !API || !OWNER_DSN) throw new Error("run with npm run lighthouse");

const RUNS = 3;
const CATEGORIES = ["performance", "accessibility", "best-practices"];
const PAGES = process.env.RELAY_LH_PAGES?.split(",") ?? [
  "/login",
  "/",
  "/endpoints",
  "/deliveries",
  "/api-keys",
];
const thresholds = JSON.parse(readFileSync(join(import.meta.dirname, "lighthouse-thresholds.json"), "utf8"));
const out = join(process.cwd(), "lighthouse-results");
mkdirSync(out, { recursive: true });

async function api(path, init = {}, token) {
  const r = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  return r;
}

/** A tenant with an endpoint, an event type, an API key and a delivery, so pages have rows. */
async function seed() {
  const cli = pathToFileURL(join(process.cwd(), "..", "control-plane", "dist", "cli.js")).href;
  const { createInvite } = await import(cli);
  const email = `lighthouse-${randomUUID()}@example.com`;
  const password = "correct horse battery staple";
  const reg = await api("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      invite_code: await createInvite(OWNER_DSN, 1, "lighthouse"),
      tenant_name: "Lighthouse",
      email,
      password,
    }),
  });
  const token = (await reg.json()).access_token;
  const ep = await (
    await api(
      "/endpoints",
      { method: "POST", body: JSON.stringify({ url: "http://127.0.0.1:9/hooks/lighthouse" }) },
      token,
    )
  ).json();
  await api("/event-types", { method: "POST", body: JSON.stringify({ name: "order.paid" }) }, token);
  await api(
    "/api-keys",
    { method: "POST", body: JSON.stringify({ name: "backend", scopes: ["events:write"] }) },
    token,
  );
  await api(`/endpoints/${ep.id}/test`, { method: "POST", body: "{}" }, token);
  return { email, password };
}

async function freshCookie({ email, password }) {
  const r = await api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const set = r.headers.getSetCookie();
  if (!set.length) throw new Error("login set no cookie");
  return set.map((c) => c.split(";")[0]).join("; ");
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  const owner = await seed();
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });
  const results = {};
  try {
    for (const page of PAGES) {
      const scores = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
      for (let i = 0; i < RUNS; i++) {
        const headers = page === "/login" ? {} : { Cookie: await freshCookie(owner) };
        const r = await lighthouse(
          `${WEB}${page}`,
          { port: chrome.port, output: ["html", "json"], logLevel: "error", extraHeaders: headers },
          { extends: "lighthouse:default", settings: { onlyCategories: CATEGORIES } },
        );
        const lhr = r.lhr;
        if (lhr.runtimeError) throw new Error(`${page}: ${lhr.runtimeError.message}`);
        if (new URL(lhr.finalDisplayedUrl).pathname !== page) {
          throw new Error(`${page} ended at ${lhr.finalDisplayedUrl}: not signed in?`);
        }
        for (const c of CATEGORIES) scores[c].push(Math.round(lhr.categories[c].score * 100));
        const name = page === "/" ? "overview" : page.slice(1);
        if (i === 0) {
          writeFileSync(join(out, `${name}.html`), r.report[0]);
          writeFileSync(join(out, `${name}.json`), r.report[1]);
        }
      }
      results[page] = Object.fromEntries(
        CATEGORIES.map((c) => [c, { median: median(scores[c]), runs: scores[c] }]),
      );
    }
  } finally {
    await chrome.kill();
  }

  let failed = 0;
  for (const [page, cats] of Object.entries(results)) {
    const line = CATEGORIES.map((c) => {
      const min = thresholds[c];
      const ok = cats[c].median >= min;
      if (!ok) failed++;
      return `${c} ${cats[c].median} (${cats[c].runs.join("/")}, min ${min})${ok ? "" : " FAIL"}`;
    });
    console.log(`${page.padEnd(12)} ${line.join("  ")}`);
  }
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
