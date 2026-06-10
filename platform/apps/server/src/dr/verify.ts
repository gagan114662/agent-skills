/**
 * Restore verification (#99, ADR-0099). Multi-dimensional so a restore that *looks* fine but is
 * subtly broken still fails the gate: row **counts** (catch truncation/partial restore), **schema**
 * (expected tables present), **freshness** (newest row within a bound — catch a stale dump), and
 * **content checksums** (a stable hash over ordered rows — catch silent corruption a count misses).
 *
 * The comparison helpers are pure (unit-tested with no DB); `verifyRestore` runs the queries against
 * a restored database and assembles the report.
 */
import type { Client } from "pg";

export interface CountMismatch {
  table: string;
  expected: number;
  actual: number;
}

export interface ChecksumMismatch {
  table: string;
  expected: string;
  actual: string;
}

/** Tables whose restored count is below the expected count (missing → actual 0). Pure. */
export function diffCounts(
  expected: Record<string, number>,
  actual: Record<string, number>,
): CountMismatch[] {
  const out: CountMismatch[] = [];
  for (const [table, want] of Object.entries(expected)) {
    const got = actual[table] ?? 0;
    if (got < want) out.push({ table, expected: want, actual: got });
  }
  return out;
}

/** Freshness of a table: is its newest row within `maxAgeMs` of `now`? An empty table is not fresh. Pure. */
export function assessFreshness(
  newest: Date | null,
  now: Date,
  maxAgeMs: number,
): { fresh: boolean; ageMs: number | null } {
  if (newest === null) return { fresh: false, ageMs: null };
  const ageMs = now.getTime() - newest.getTime();
  return { fresh: ageMs <= maxAgeMs, ageMs };
}

/** Tables whose content checksum differs between expected and actual. Pure. */
export function checksumsMatch(
  expected: Record<string, string>,
  actual: Record<string, string>,
): ChecksumMismatch[] {
  const out: ChecksumMismatch[] = [];
  for (const [table, want] of Object.entries(expected)) {
    const got = actual[table] ?? "";
    if (got !== want) out.push({ table, expected: want, actual: got });
  }
  return out;
}

export interface VerifyExpectations {
  /** Expected minimum row counts per table (from the source DB at dump time). */
  counts: Record<string, number>;
  /** Stable content checksums per table (from the source DB). */
  checksums: Record<string, string>;
  /** Tables that must exist in the restored schema. */
  tables: string[];
  /** Optional freshness probe: the newest `column` of `table` must be within `maxAgeMs` of `now`. */
  freshness?: { table: string; column: string; maxAgeMs: number; now: Date };
}

export interface VerifyReport {
  ok: boolean;
  countMismatches: CountMismatch[];
  checksumMismatches: ChecksumMismatch[];
  missingTables: string[];
  freshness: { fresh: boolean; ageMs: number | null } | null;
}

/** A stable content checksum over a table's rows, independent of physical row order. */
export async function tableChecksum(client: Client, table: string): Promise<string> {
  // md5 of the row's text representation, aggregated over a deterministic ordering. `t::text` renders
  // the whole row, so any column change moves the hash; ordering by it makes the aggregate stable.
  const res = await client.query<{ checksum: string | null }>(
    `SELECT md5(coalesce(string_agg(rowtext, '|' ORDER BY rowtext), '')) AS checksum
       FROM (SELECT t::text AS rowtext FROM ${quoteIdent(table)} t) s`,
  );
  return res.rows[0]?.checksum ?? "";
}

async function tableCount(client: Client, table: string): Promise<number> {
  const res = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteIdent(table)}`);
  return Number(res.rows[0]?.n ?? 0);
}

async function existingTables(client: Client, tables: string[]): Promise<Set<string>> {
  const res = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  );
  return new Set(res.rows.map((r) => r.table_name));
}

/** Read a table's count + checksum from a (source) database — what the restore is verified against. */
export async function snapshotExpectations(
  client: Client,
  tables: string[],
  freshness?: { table: string; column: string; maxAgeMs: number; now: Date },
): Promise<VerifyExpectations> {
  const counts: Record<string, number> = {};
  const checksums: Record<string, string> = {};
  for (const t of tables) {
    counts[t] = await tableCount(client, t);
    checksums[t] = await tableChecksum(client, t);
  }
  return { counts, checksums, tables, freshness };
}

/** Run all verification dimensions against a restored database and assemble the report. */
export async function verifyRestore(
  client: Client,
  expectations: VerifyExpectations,
): Promise<VerifyReport> {
  const present = await existingTables(client, expectations.tables);
  const missingTables = expectations.tables.filter((t) => !present.has(t));

  const actualCounts: Record<string, number> = {};
  const actualChecksums: Record<string, string> = {};
  for (const t of expectations.tables) {
    if (!present.has(t)) continue;
    actualCounts[t] = await tableCount(client, t);
    actualChecksums[t] = await tableChecksum(client, t);
  }

  const countMismatches = diffCounts(expectations.counts, actualCounts);
  const checksumMismatches = checksumsMatch(expectations.checksums, actualChecksums);

  let freshness: { fresh: boolean; ageMs: number | null } | null = null;
  if (expectations.freshness) {
    const { table, column, maxAgeMs, now } = expectations.freshness;
    const res = await client.query<{ newest: Date | null }>(
      `SELECT max(${quoteIdent(column)}) AS newest FROM ${quoteIdent(table)}`,
    );
    const newest = res.rows[0]?.newest ?? null;
    freshness = assessFreshness(newest ? new Date(newest) : null, now, maxAgeMs);
  }

  const ok =
    missingTables.length === 0 &&
    countMismatches.length === 0 &&
    checksumMismatches.length === 0 &&
    (freshness === null || freshness.fresh);

  return { ok, countMismatches, checksumMismatches, missingTables, freshness };
}

/** Conservative identifier quoting — anchor table/column names are operator-supplied, not user input. */
function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
}
