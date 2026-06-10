/**
 * Thin `pg_dump` / `psql` wrappers for the backup + restore drill (#99, ADR-0099).
 *
 * The off-site backup is `pg_dump --format=plain | gzip`; the restore is `gunzip | psql`. We shell out
 * to the standard Postgres client tools (the same ones the workflow uses) rather than reimplement a
 * dumper — vendor-neutral and battle-tested. `pgToolsAvailable()` lets tests skip cleanly where the
 * client tools are absent (e.g. a dev laptop without postgresql-client).
 */
import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGzip, createGunzip } from "node:zlib";

/** True when both `pg_dump` and `psql` are on PATH and runnable. Never throws. */
export async function pgToolsAvailable(): Promise<boolean> {
  return (await canRun("pg_dump")) && (await canRun("psql"));
}

function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export interface DumpResult {
  /** Size of the gzipped dump on disk. */
  bytes: number;
  /** Wall-clock duration of the dump in ms — the measured RPO input (ADR-0099 §RPO). */
  ms: number;
}

/**
 * Dump `databaseUrl` to `outGzPath` as gzipped plain SQL. `--no-owner --no-privileges` keeps the dump
 * portable across roles so it restores into any throwaway DB. Rejects on a non-zero `pg_dump` exit.
 */
export async function dumpDatabase(
  databaseUrl: string,
  outGzPath: string,
  startedAtMs: number = Date.now(),
): Promise<DumpResult> {
  await new Promise<void>((resolve, reject) => {
    const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", "--format=plain", databaseUrl]);
    const gzip = createGzip();
    const out = createWriteStream(outGzPath);
    let stderr = "";
    dump.stderr.on("data", (d) => (stderr += String(d)));
    dump.on("error", reject);
    out.on("error", reject);
    dump.on("close", (code) => {
      if (code !== 0) reject(new Error(`pg_dump exited ${code}: ${stderr.trim()}`));
    });
    out.on("finish", () => resolve());
    dump.stdout.pipe(gzip).pipe(out);
  });
  const s = await stat(outGzPath);
  return { bytes: s.size, ms: Date.now() - startedAtMs };
}

/**
 * Restore a gzipped plain-SQL dump at `gzPath` into `targetUrl`. `ON_ERROR_STOP=1` makes psql fail
 * loudly on the first error rather than limping to a half-restored state. Rejects on a non-zero exit.
 */
export async function restoreDatabase(targetUrl: string, gzPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const psql = spawn("psql", ["--quiet", "-v", "ON_ERROR_STOP=1", targetUrl]);
    let stderr = "";
    psql.stderr.on("data", (d) => (stderr += String(d)));
    psql.on("error", reject);
    psql.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql restore exited ${code}: ${stderr.trim()}`));
    });
    createReadStream(gzPath).pipe(createGunzip()).pipe(psql.stdin);
  });
}
