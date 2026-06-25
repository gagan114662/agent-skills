import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationFileNames, migrationSlug, timestampPrefix } from "./new-migration.mjs";

test("normalizes human migration names into safe slugs", () => {
  assert.equal(migrationSlug("Add Support SLA Receipts!"), "add_support_sla_receipts");
});

test("formats UTC timestamp prefixes so parallel branches do not reserve numeric slots", () => {
  const date = new Date(Date.UTC(2026, 5, 25, 7, 8, 9));

  assert.equal(timestampPrefix(date), "20260625070809");
  assert.deepEqual(migrationFileNames("customer status", date), {
    up: "20260625070809_customer_status.sql",
    down: "20260625070809_customer_status.down.sql",
  });
});
