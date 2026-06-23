import type { QueryResult, QueryResultRow } from "pg";
import { expectedMigrationFiles } from "./migrate.js";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

export class SchemaDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

function latestVersion(migrations: readonly string[] | null): string {
  if (!migrations) return "missing _migrations ledger";
  return migrations.at(-1) ?? "no applied migrations";
}

export function assertMigrationSchemaCompatible(
  expectedMigrations: readonly string[],
  appliedMigrations: readonly string[] | null,
): void {
  const expected = [...expectedMigrations].sort();
  const applied = appliedMigrations ? [...appliedMigrations].sort() : null;
  const appliedSet = new Set(applied ?? []);
  const expectedSet = new Set(expected);

  const missing = expected.filter((name) => !appliedSet.has(name));
  const unexpected = (applied ?? []).filter((name) => !expectedSet.has(name));

  if (missing.length === 0 && unexpected.length === 0) return;

  const details = [
    `expected latest migration ${latestVersion(expected)}`,
    `actual latest migration ${latestVersion(applied)}`,
  ];
  if (missing.length > 0) details.push(`missing migrations: ${missing.join(", ")}`);
  if (unexpected.length > 0) details.push(`unexpected migrations: ${unexpected.join(", ")}`);

  throw new SchemaDriftError(`database schema drift detected: ${details.join("; ")}`);
}

export async function readAppliedMigrationFiles(client: Queryable): Promise<string[] | null> {
  const table = await client.query<{ table_name: string | null }>(
    `SELECT to_regclass('_migrations')::text AS table_name`,
  );
  if (!table.rows[0]?.table_name) return null;

  const applied = await client.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`);
  return applied.rows.map((row) => row.name);
}

export async function assertDatabaseSchemaCompatible(client: Queryable): Promise<void> {
  const [expected, applied] = await Promise.all([
    expectedMigrationFiles(),
    readAppliedMigrationFiles(client),
  ]);
  assertMigrationSchemaCompatible(expected, applied);
}
