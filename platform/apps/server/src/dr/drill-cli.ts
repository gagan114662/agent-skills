/**
 * VALIDATION drill CLI (#99, ADR-0099) — `pnpm --filter @reload/server dr:drill`.
 *
 * The scheduled CI drill runs this against a throwaway Postgres service container: dump the live
 * (migrated) source, restore it into a fresh throwaway DB, and verify counts + schema + freshness +
 * checksums against the source. **Fails loudly** (exit 1) on any verification failure — so a corrupt
 * dump or a broken dump/restore pipeline is caught on a Tuesday, not at 2 a.m.
 *
 * Non-destructive: it only reads the source and writes to a throwaway DB it creates and drops.
 * Optional `--dump <path.sql.gz>` validates a specific (e.g. downloaded off-site) dump instead of
 * generating a fresh one.
 */
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadEnv } from "../env.js";
import { LocalDirObjectStore } from "./object-store.js";
import { pgToolsAvailable, dumpDatabase } from "./dump.js";
import { preflight, runValidationDrill } from "./runbook.js";

const ANCHOR_TABLES = ["_migrations", "workspaces"];

function throwawayUrlFrom(sourceUrl: string, dbName: string): string {
  return sourceUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dumpFlagIdx = argv.indexOf("--dump");
  const explicitDump = dumpFlagIdx >= 0 ? argv[dumpFlagIdx + 1] : undefined;

  if (!(await pgToolsAvailable())) {
    console.error("✗ dr:drill — pg_dump/psql not found on PATH (install postgresql-client)");
    process.exit(1);
  }

  const env = loadEnv();
  const sourceUrl = env.databaseUrl;
  const store = new LocalDirObjectStore(env.dr.localDir);
  const prefix = env.dr.dumpPrefix;

  // 1) Produce the dump under test: either the supplied one, or a fresh dump of the live source.
  const stamp = Date.now();
  const key = `${prefix}reload-${stamp}.sql.gz`;
  if (explicitDump) {
    console.log(`dr:drill — validating supplied dump ${explicitDump}`);
    await store.put(key, explicitDump);
  } else {
    const workDir = await mkdtemp(join(tmpdir(), "dr-dump-"));
    const out = join(workDir, `reload-${stamp}.sql.gz`);
    const result = await dumpDatabase(sourceUrl, out);
    console.log(`dr:drill — dumped source in ${result.ms}ms (${result.bytes} bytes gzipped)`);
    await store.put(key, out);
  }

  // 2) Pre-flight: abort cleanly if the dump is missing/empty (no outage — nothing was changed).
  const latest = await store.getLatest(prefix);
  const pre = preflight({
    credsPresent: true, // local dir store needs no creds
    dumpPresent: latest !== null,
    dumpBytes: latest?.bytes ?? 0,
    dumpAgeMs: 0,
    maxDumpAgeMs: env.dr.maxDumpAgeMs,
  });
  if (!pre.proceed) {
    console.error(`✗ dr:drill — preflight aborted: ${pre.abort}`);
    process.exit(1);
  }

  // 3) Create a throwaway target, run the drill, drop the throwaway.
  const throwaway = `reload_dr_drill_${stamp}`;
  const admin = new pg.Client({ connectionString: sourceUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${throwaway}`);
  const throwawayUrl = throwawayUrlFrom(sourceUrl, throwaway);

  try {
    const report = await runValidationDrill({
      store,
      prefix,
      sourceUrl,
      throwawayUrl,
      anchorTables: ANCHOR_TABLES,
    });

    if (report.ok) {
      console.log(`✓ dr:drill — restore verified (tables=${ANCHOR_TABLES.join(",")})`);
      process.exitCode = 0;
    } else {
      console.error("✗ dr:drill — VERIFICATION FAILED");
      console.error(JSON.stringify(report, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
      [throwaway],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${throwaway}`);
    await admin.end();
  }
}

main().catch((err) => {
  console.error("✗ dr:drill — unexpected failure:", err instanceof Error ? err.message : err);
  process.exit(1);
});
