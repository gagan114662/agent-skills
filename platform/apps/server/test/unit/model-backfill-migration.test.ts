import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_AGENT_MODELS, DEFAULT_AGENT_MODEL } from "../../src/runtime/models.js";

/**
 * #293 — static guards on the backfill migration. The SQL hardcodes the servable allowlist (SQL can't
 * import the TS const), so this anti-drift test pins the migration's `NOT IN (...)` list to
 * KNOWN_AGENT_MODELS: if someone adds/removes a servable model in code without updating the migration,
 * this fails. It also pins the idempotency shape (only non-null, only unservable, target = default) and
 * that the down is a deliberate no-op (the data repair is not reverted).
 */
const up = readFileSync(
  fileURLToPath(new URL("../../drizzle/0293_workspace_model_backfill.sql", import.meta.url)),
  "utf8",
);
const down = readFileSync(
  fileURLToPath(new URL("../../drizzle/0293_workspace_model_backfill.down.sql", import.meta.url)),
  "utf8",
);

/** Pull the model ids out of the SQL `NOT IN ( 'a', 'b', ... )` list. */
function notInModels(sql: string): string[] {
  const m = sql.match(/NOT IN\s*\(([^)]*)\)/i);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("0293 backfill migration — SQL stays in lockstep with the code", () => {
  it("the NOT IN servable list EXACTLY matches KNOWN_AGENT_MODELS (anti-drift)", () => {
    expect(notInModels(up).sort()).toEqual([...KNOWN_AGENT_MODELS].sort());
  });

  it("targets the managed default and only repairs non-null overrides (idempotent + null-safe)", () => {
    const normalized = up.replace(/\s+/g, " ");
    expect(normalized).toMatch(new RegExp(`SET model = '${DEFAULT_AGENT_MODEL}'`, "i"));
    expect(normalized).toMatch(/WHERE model IS NOT NULL/i);
    expect(normalized).toMatch(/AND model NOT IN \(/i);
    // The target must itself be in the servable list — else the UPDATE wouldn't be idempotent.
    expect(notInModels(up)).toContain(DEFAULT_AGENT_MODEL);
  });

  it("does not rewrite a NULL override (null already means 'use the deployment default')", () => {
    // No `SET model = ... WHERE model IS NULL` and no unconditional update.
    expect(up).not.toMatch(/WHERE\s+model\s+IS\s+NULL/i);
  });

  it("the down is a deliberate no-op — the data repair is not reverted", () => {
    expect(down.toLowerCase()).toContain("no-op");
    expect(down).not.toMatch(/UPDATE\s+workspace_agent_credentials/i);
    expect(down).not.toMatch(/claude-fable-5/i); // never restores an unservable id
  });
});
