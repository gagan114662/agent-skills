import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnv } from "../env.js";
import * as schema from "./schema/index.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Lazily-created shared pg pool. */
export function getPool(): pg.Pool {
  if (!pool) {
    const env = loadEnv();
    // #113: pool size is a worker-concurrency knob (DATABASE_POOL_MAX; default 10) — the per-replica
    // DB-bound capacity ceiling documented in docs/scaling.md.
    pool = new Pool({ connectionString: env.databaseUrl, max: env.databasePoolMax });
  }
  return pool;
}

/**
 * Drizzle handle, typed against the full schema (#2).
 * Note: this initializes the pool at module import. `pg` opens no socket until the
 * first query, so there's no eager connection — but the Pool object itself exists eagerly.
 */
export const db = drizzle(getPool(), { schema });

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
