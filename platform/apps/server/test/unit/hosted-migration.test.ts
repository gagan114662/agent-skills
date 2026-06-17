import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * #266 — a static guard on the hosted-publishing migration. A real custom domain MUST be globally unique
 * (Gemini security review: without it two tenants could claim the same domain → hijacking / ambiguous
 * serve-by-host). This pins the partial unique index in BOTH the up and down migrations so a future edit
 * can't silently drop the protection. (The behaviour itself is verified against real Postgres in CI's
 * integration job + the manual up/down/re-up check.)
 */
const up = readFileSync(
  fileURLToPath(new URL("../../drizzle/0266_hosted_publishing.sql", import.meta.url)),
  "utf8",
);
const down = readFileSync(
  fileURLToPath(new URL("../../drizzle/0266_hosted_publishing.down.sql", import.meta.url)),
  "utf8",
);

describe("0266 hosted migration — custom_domain global uniqueness", () => {
  it("UP creates a PARTIAL unique index on custom_domain (NULLs allowed, real domains unique)", () => {
    const normalized = up.replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS hosted_sites_custom_domain_uq ON hosted_sites \(custom_domain\) WHERE custom_domain IS NOT NULL/i,
    );
  });

  it("DOWN drops the custom_domain unique index before dropping the table", () => {
    expect(down).toMatch(/DROP INDEX IF EXISTS hosted_sites_custom_domain_uq/i);
    const dropIdx = down.search(/DROP INDEX IF EXISTS hosted_sites_custom_domain_uq/i);
    const dropTbl = down.search(/DROP TABLE IF EXISTS hosted_sites\b/i);
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(dropTbl).toBeGreaterThan(dropIdx); // index dropped before its table
  });

  it("keeps the subdomain unique index too (both addressing modes are unique)", () => {
    expect(up).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS hosted_sites_subdomain_uq/i);
  });
});
