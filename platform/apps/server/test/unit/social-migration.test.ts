import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * #269 — a static guard on the social-aggregator migration. Pins the two tables + their status CHECKs and
 * the FK cascade in BOTH the up and down migrations so a future edit can't silently drop them. (The
 * behaviour itself is verified against real Postgres in CI's integration job + the manual up/down/re-up.)
 */
const up = readFileSync(
  fileURLToPath(new URL("../../drizzle/0269_social_aggregator_bridge.sql", import.meta.url)),
  "utf8",
);
const down = readFileSync(
  fileURLToPath(new URL("../../drizzle/0269_social_aggregator_bridge.down.sql", import.meta.url)),
  "utf8",
);

describe("0269 social migration", () => {
  it("UP creates both tables, workspace-scoped with cascade", () => {
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS social_posts/i);
    expect(up).toMatch(/CREATE TABLE IF NOT EXISTS social_post_results/i);
    expect(up).toMatch(/workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/i);
    expect(up).toMatch(/post_id uuid NOT NULL REFERENCES social_posts\(id\) ON DELETE CASCADE/i);
  });

  it("UP constrains the post + result status enums", () => {
    expect(up).toMatch(/social_posts_status_ck/i);
    expect(up).toMatch(/social_post_results_status_ck/i);
  });

  it("DOWN drops the results table before its parent (FK order)", () => {
    const dropResults = down.search(/DROP TABLE IF EXISTS social_post_results\b/i);
    const dropPosts = down.search(/DROP TABLE IF EXISTS social_posts\b/i);
    expect(dropResults).toBeGreaterThanOrEqual(0);
    expect(dropPosts).toBeGreaterThan(dropResults);
  });
});
