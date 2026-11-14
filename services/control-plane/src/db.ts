import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(dsn: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: toConnectionString(dsn), max, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {}); // an idle client lost its connection; the pool replaces it
  return pool;
}

/** libpq keyword DSNs ("host=... user=...") and URLs are both accepted. */
export function toConnectionString(dsn: string): string {
  if (/^postgres(ql)?:\/\//.test(dsn)) return dsn;
  const parts = Object.fromEntries(
    dsn
      .trim()
      .split(/\s+/)
      .map((kv) => kv.split("=") as [string, string]),
  );
  const url = new URL("postgresql://localhost");
  if (parts.host) url.hostname = parts.host;
  if (parts.port) url.port = parts.port;
  if (parts.user) url.username = parts.user;
  if (parts.password) url.password = parts.password;
  if (parts.dbname) url.pathname = `/${parts.dbname}`;
  return url.toString();
}

/** Run fn in one transaction scoped to a tenant: row-level security sees only that tenant. */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** A transaction with no tenant (only the guarded relay_auth functions can do anything useful). */
export async function withoutTenant<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
