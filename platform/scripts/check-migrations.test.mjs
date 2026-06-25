import { test } from "node:test";
import assert from "node:assert/strict";
import { touchedObjects, validateMigrationSet } from "./check-migrations.mjs";

test("extracts table objects touched by common migration statements", () => {
  const sql = [
    "-- ignored CREATE TABLE comments;",
    "CREATE TABLE IF NOT EXISTS workspaces (id text);",
    "ALTER TABLE \"messages\" ADD COLUMN body text;",
    "CREATE UNIQUE INDEX IF NOT EXISTS messages_workspace_idx ON messages (workspace_id);",
  ].join("\n");

  assert.deepEqual(touchedObjects(sql), ["messages", "workspaces"]);
});

test("allows duplicate numeric prefixes when migrations touch disjoint objects", () => {
  const result = validateMigrationSet([
    { file: "0007_notifications.sql", sql: "CREATE TABLE notifications (id text);" },
    { file: "0007_notifications.down.sql", sql: "DROP TABLE notifications;" },
    { file: "0007_shared_memory.sql", sql: "CREATE TABLE shared_memory (id text);" },
    { file: "0007_shared_memory.down.sql", sql: "DROP TABLE shared_memory;" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ["0007_notifications.sql", "0007_shared_memory.sql"]);
});

test("rejects duplicate numeric prefixes that touch the same object", () => {
  const result = validateMigrationSet([
    { file: "0510_alpha.sql", sql: "ALTER TABLE workspaces ADD COLUMN alpha text;" },
    { file: "0510_alpha.down.sql", sql: "ALTER TABLE workspaces DROP COLUMN alpha;" },
    { file: "0510_beta.sql", sql: "ALTER TABLE workspaces ADD COLUMN beta text;" },
    { file: "0510_beta.down.sql", sql: "ALTER TABLE workspaces DROP COLUMN beta;" },
  ]);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /0510: 0510_alpha\.sql and 0510_beta\.sql/);
  assert.match(result.errors.join("\n"), /workspaces/);
});

test("requires every up migration to have a paired down migration", () => {
  const result = validateMigrationSet([{ file: "0511_missing_down.sql", sql: "CREATE TABLE x (id text);" }]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["0511_missing_down.sql: missing paired down migration"]);
});

test("allows timestamp-prefixed migrations and preserves lexicographic order", () => {
  const result = validateMigrationSet([
    { file: "20260625010203_alpha.sql", sql: "CREATE TABLE alpha (id text);" },
    { file: "20260625010203_alpha.down.sql", sql: "DROP TABLE alpha;" },
    { file: "20260625010204_beta.sql", sql: "CREATE TABLE beta (id text);" },
    { file: "20260625010204_beta.down.sql", sql: "DROP TABLE beta;" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ["20260625010203_alpha.sql", "20260625010204_beta.sql"]);
});

test("rejects newly added legacy numeric migrations", () => {
  const result = validateMigrationSet(
    [
      { file: "0512_legacy.sql", sql: "CREATE TABLE legacy (id text);" },
      { file: "0512_legacy.down.sql", sql: "DROP TABLE legacy;" },
    ],
    { addedFiles: ["0512_legacy.sql", "0512_legacy.down.sql"] },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /new migrations must use timestamp prefixes/);
});
