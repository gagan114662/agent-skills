import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "../env.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Lazily-created shared pg pool. No schema yet — issue #2 introduces tables. */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: loadEnv().databaseUrl, max: 10 });
  }
  return pool;
}

/** Drizzle handle for future query work (schema arrives in #2). */
export const db = drizzle(getPool());

/** Returns true if Postgres answers a trivial query. Never throws. */
export async function pingDb(): Promise<boolean> {
  try {
    const res = await getPool().query("select 1 as ok");
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
