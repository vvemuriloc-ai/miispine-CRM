// Owner Postgres pool for the jobs — bypasses RLS (whole-book access).
import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.ownerUrl, max: config.pgMax });

export async function q(text: string, params: any[] = []) {
  return pool.query(text, params);
}

// Bulk insert from an array of objects; missing keys become NULL.
export async function insertRows(table: string, cols: string[], rows: Record<string, any>[]) {
  if (!rows.length) return 0;
  const params: any[] = [];
  const tuples = rows.map((row) => {
    const ph = cols.map((c) => { params.push(row[c] ?? null); return `$${params.length}`; });
    return `(${ph.join(",")})`;
  });
  await pool.query(`insert into ${table} (${cols.join(",")}) values ${tuples.join(",")}`, params);
  return rows.length;
}
