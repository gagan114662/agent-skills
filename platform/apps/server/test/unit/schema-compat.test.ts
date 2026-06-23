import { describe, expect, it } from "vitest";
import { SchemaDriftError, assertMigrationSchemaCompatible } from "../../src/db/schema-compat.js";

describe("schema compatibility startup check (#678)", () => {
  it("accepts a database whose migration ledger exactly matches the repo schema", () => {
    expect(() =>
      assertMigrationSchemaCompatible(["0001_base.sql", "0002_agents.sql"], [
        "0001_base.sql",
        "0002_agents.sql",
      ]),
    ).not.toThrow();
  });

  it("fails loudly when the database is behind the repo schema", () => {
    expect(() =>
      assertMigrationSchemaCompatible(["0001_base.sql", "0002_agents.sql"], ["0001_base.sql"]),
    ).toThrowError(
      new SchemaDriftError(
        "database schema drift detected: expected latest migration 0002_agents.sql; actual latest migration 0001_base.sql; missing migrations: 0002_agents.sql",
      ),
    );
  });

  it("fails loudly when the database has an unknown newer migration", () => {
    expect(() =>
      assertMigrationSchemaCompatible(["0001_base.sql"], ["0001_base.sql", "9999_future.sql"]),
    ).toThrowError(
      new SchemaDriftError(
        "database schema drift detected: expected latest migration 0001_base.sql; actual latest migration 9999_future.sql; unexpected migrations: 9999_future.sql",
      ),
    );
  });

  it("fails loudly when the database has no migration ledger", () => {
    expect(() => assertMigrationSchemaCompatible(["0001_base.sql"], null)).toThrowError(
      new SchemaDriftError(
        "database schema drift detected: expected latest migration 0001_base.sql; actual latest migration missing _migrations ledger; missing migrations: 0001_base.sql",
      ),
    );
  });
});
