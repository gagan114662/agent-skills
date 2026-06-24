import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function migration(path: string): string {
  return readFileSync(fileURLToPath(new URL("../../drizzle/" + path, import.meta.url)), "utf8");
}

describe("rollback migrations that narrow CHECK constraints (#934)", () => {
  it("0171 deletes self-QA reliability pages before restoring pre-0171 checks", () => {
    const down = migration("0171_self_qa_loop.down.sql");

    const cleanup = down.search(/DELETE FROM reliability_pages WHERE source = 'selfqa' OR kind = 'selfqa_critical';/i);
    const sourceConstraint = down.search(/ADD CONSTRAINT reliability_pages_source_ck/i);
    const kindConstraint = down.search(/ADD CONSTRAINT reliability_pages_kind_ck/i);

    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(sourceConstraint).toBeGreaterThan(cleanup);
    expect(kindConstraint).toBeGreaterThan(cleanup);
  });

  it("audited down migrations remove rows that would violate re-narrowed checks before adding constraints", () => {
    const cases = [
      {
        file: "0250_realworld_publish_site.down.sql",
        cleanup: /DELETE FROM realworld_artifacts WHERE tool = 'publish_site';/i,
        constraint: /ADD CONSTRAINT realworld_artifacts_tool_ck/i,
      },
      {
        file: "0271_brand_kit_assets.down.sql",
        cleanup: /DELETE FROM realworld_artifacts WHERE tool = 'generate_image';/i,
        constraint: /ADD CONSTRAINT realworld_artifacts_tool_ck/i,
      },
      {
        file: "0364_delivery_site_pr_channel.down.sql",
        cleanup: /DELETE FROM delivery_receipts WHERE channel = 'site_pr';/i,
        constraint: /ADD CONSTRAINT delivery_receipts_channel_ck/i,
      },
    ];

    for (const c of cases) {
      const down = migration(c.file);
      const cleanup = down.search(c.cleanup);
      const constraint = down.search(c.constraint);
      expect(cleanup, c.file).toBeGreaterThanOrEqual(0);
      expect(constraint, c.file).toBeGreaterThan(cleanup);
    }
  });
});
