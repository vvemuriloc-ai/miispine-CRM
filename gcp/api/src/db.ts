// Postgres pool + the per-request tenant transaction.
//
// The pool connects as `miicase_app` (NOT the table owner), so RLS is enforced
// against every query here. withTenant() opens a transaction and stamps the
// app.* session variables with set_config(..., is_local => true) — the
// parameterized, injection-safe form of `SET LOCAL`. RLS (0002/0003) reads them.
import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.pgMax });

export type Tenant = { uid: string | null; firmId: string | null; isStaff: boolean };

export async function withTenant<T>(
  t: Tenant,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.user_id', $1, true), " +
      "       set_config('app.firm_id', $2, true), " +
      "       set_config('app.is_staff', $3, true)",
      [t.uid ?? "", t.firmId ?? "", t.isStaff ? "true" : "false"],
    );
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
