import { describe, it, expect } from "vitest";
import {
  planModelBackfill,
  isFullyRepaired,
  type WorkspaceModelRow,
} from "../../src/runtime/model-backfill.js";
import { DEFAULT_AGENT_MODEL } from "../../src/runtime/models.js";

/**
 * #293 — the pure backfill decision. Covers what migration 0246 missed: it only matched the EXACT
 * `claude-fable-5` string and didn't re-run on prod. This plan repairs EVERY non-null unservable
 * override to the managed default, leaves null/servable rows alone, and is idempotent so the prod run
 * (owner-gated) can be re-applied safely.
 */
describe("planModelBackfill (#293 — repair every unservable workspace model override)", () => {
  it("rewrites a non-null unservable override (the claude-fable-5 class) to the managed default", () => {
    const plan = planModelBackfill([{ workspaceId: "ws-seo", model: "claude-fable-5" }], {});
    expect(plan.changes).toEqual([
      { workspaceId: "ws-seo", from: "claude-fable-5", to: DEFAULT_AGENT_MODEL },
    ]);
    expect(plan.scanned).toBe(1);
    expect(plan.unchanged).toBe(0);
    expect(plan.target).toBe(DEFAULT_AGENT_MODEL);
  });

  it("repairs ANY unservable id, not just fable-5 (the gap migration 0246's exact-match UPDATE left)", () => {
    const rows: WorkspaceModelRow[] = [
      { workspaceId: "ws-a", model: "claude-fable-5" },
      { workspaceId: "ws-b", model: "gpt-4o" },
      { workspaceId: "ws-c", model: "claude-2.1" },
    ];
    const plan = planModelBackfill(rows, {});
    expect(plan.changes.map((c) => c.workspaceId)).toEqual(["ws-a", "ws-b", "ws-c"]);
    expect(plan.changes.every((c) => c.to === DEFAULT_AGENT_MODEL)).toBe(true);
  });

  it("leaves a null override untouched (null already means 'use the deployment default')", () => {
    const plan = planModelBackfill([{ workspaceId: "ws-null", model: null }], {});
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("leaves an already-servable owner pick untouched (no clobbering a valid choice)", () => {
    const rows: WorkspaceModelRow[] = [
      { workspaceId: "ws-1", model: DEFAULT_AGENT_MODEL },
      { workspaceId: "ws-2", model: "claude-sonnet-4-6" },
      { workspaceId: "ws-3", model: "claude-haiku-4-5" },
    ];
    const plan = planModelBackfill(rows, {});
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toBe(3);
  });

  it("treats a blank-string override as unservable and reports it legibly as '(empty)'", () => {
    const plan = planModelBackfill([{ workspaceId: "ws-blank", model: "" }], {});
    expect(plan.changes).toEqual([{ workspaceId: "ws-blank", from: "(empty)", to: DEFAULT_AGENT_MODEL }]);
  });

  it("respects the RELOAD_KNOWN_MODELS escape hatch (a newly-valid model is NOT 'repaired')", () => {
    const env = { RELOAD_KNOWN_MODELS: "claude-future-9" };
    const plan = planModelBackfill([{ workspaceId: "ws-new", model: "claude-future-9" }], env);
    expect(plan.changes).toEqual([]);
    // Without the escape hatch the same id is unservable → repaired.
    expect(planModelBackfill([{ workspaceId: "ws-new", model: "claude-future-9" }], {}).changes).toHaveLength(1);
  });

  it("mixes the three cases and counts them correctly", () => {
    const rows: WorkspaceModelRow[] = [
      { workspaceId: "ws-bad", model: "claude-fable-5" },
      { workspaceId: "ws-null", model: null },
      { workspaceId: "ws-ok", model: "claude-opus-4-8" },
    ];
    const plan = planModelBackfill(rows, {});
    expect(plan.scanned).toBe(3);
    expect(plan.changes).toHaveLength(1);
    expect(plan.unchanged).toBe(2);
  });

  it("is a no-op on an empty input", () => {
    const plan = planModelBackfill([], {});
    expect(plan).toEqual({ changes: [], scanned: 0, unchanged: 0, target: DEFAULT_AGENT_MODEL });
  });

  it("is IDEMPOTENT: applying the plan then re-planning yields zero further changes", () => {
    const rows: WorkspaceModelRow[] = [
      { workspaceId: "ws-a", model: "claude-fable-5" },
      { workspaceId: "ws-b", model: "garbage" },
      { workspaceId: "ws-c", model: null },
      { workspaceId: "ws-d", model: "claude-sonnet-4-6" },
    ];
    const first = planModelBackfill(rows, {});
    expect(first.changes).toHaveLength(2);

    // Simulate the apply: every changed row now holds its target value.
    const applied: WorkspaceModelRow[] = rows.map((r) => {
      const change = first.changes.find((c) => c.workspaceId === r.workspaceId);
      return change ? { ...r, model: change.to } : r;
    });

    const second = planModelBackfill(applied, {});
    expect(second.changes).toEqual([]);
    expect(isFullyRepaired(applied, {})).toBe(true);
    expect(isFullyRepaired(rows, {})).toBe(false);
  });
});
