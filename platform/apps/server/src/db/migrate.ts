/**
 * Minimal migration runner with real up/down support (ADR-0002 #3).
 *
 *   tsx src/db/migrate.ts up      apply all pending NNNN_*.sql
 *   tsx src/db/migrate.ts down    revert the most recently applied migration via NNNN_*.down.sql
 *   tsx src/db/migrate.ts reset   revert everything, then re-apply
 *
 * Migrations live in ../../drizzle relative to this file. Each up file `NNNN_name.sql`
 * has a paired `NNNN_name.down.sql`. Applied migrations are tracked in `_migrations`.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnv } from "../env.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/**
 * Ordering is the **full filename** sorted lexicographically — not the numeric prefix. This makes
 * a duplicate prefix deterministic: `0007_notifications.sql` sorts before `0007_shared_memory.sql`
 * (the `_notifications` vs `_shared_memory` suffix breaks the tie, "n" < "s"), and `down()` mirrors
 * it with `ORDER BY name DESC`, so revert order is the exact reverse. Duplicate prefixes arose from
 * sibling feature branches reserving the same next-free number; they are safe because each pair of
 * same-prefix migrations is additive and mutually independent (no shared table). We do **not**
 * renumber: `_migrations` records the applied filename, so renaming a shipped migration would orphan
 * the ledger row on every deployed database. See drizzle/README.md.
 */
export async function expectedMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql")).sort();
}

async function applied(client: pg.Client): Promise<Set<string>> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const res = await client.query<{ name: string }>(`SELECT name FROM _migrations`);
  return new Set(res.rows.map((r) => r.name));
}

async function runSqlFile(client: pg.Client, file: string): Promise<void> {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  await client.query(sql);
}

async function up(client: pg.Client): Promise<void> {
  const done = await applied(client);
  const pending = (await expectedMigrationFiles()).filter((f) => !done.has(f));
  if (pending.length === 0) {
    console.log("up: nothing pending");
    return;
  }
  for (const file of pending) {
    await client.query("BEGIN");
    try {
      await runSqlFile(client, file);
      await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log(`up: applied ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
}

async function down(client: pg.Client): Promise<boolean> {
  await applied(client);
  const res = await client.query<{ name: string }>(
    `SELECT name FROM _migrations ORDER BY name DESC LIMIT 1`,
  );
  const last = res.rows[0]?.name;
  if (!last) {
    console.log("down: nothing to revert");
    return false;
  }
  const downFile = last.replace(/\.sql$/, ".down.sql");
  await client.query("BEGIN");
  try {
    await runSqlFile(client, downFile);
    await client.query(`DELETE FROM _migrations WHERE name = $1`, [last]);
    await client.query("COMMIT");
    console.log(`down: reverted ${last}`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export type MigrateCommand = "up" | "down" | "reset";

/** Programmatic entry point (also used by the integration test harness). */
export async function runMigrations(cmd: MigrateCommand = "up"): Promise<void> {
  const client = new pg.Client({ connectionString: loadEnv().databaseUrl });
  await client.connect();
  try {
    if (cmd === "up") {
      await up(client);
    } else if (cmd === "down") {
      await down(client);
    } else if (cmd === "reset") {
      while (await down(client)) {
        /* revert all */
      }
      await up(client);
    } else {
      throw new Error(`unknown command "${cmd}" (use up | down | reset)`);
    }
  } finally {
    await client.end();
  }
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("migrate.ts") || invokedPath.endsWith("migrate.js")) {
  runMigrations((process.argv[2] as MigrateCommand) ?? "up").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
