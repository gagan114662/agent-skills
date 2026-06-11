import { describe, it, expect } from "vitest";
import { EvalService } from "../../src/evals/service.js";
import type { EvalServiceDeps } from "../../src/evals/service.js";
import type { EvalSuite } from "../../src/evals/types.js";
import type { EvalRunRecord } from "../../src/evals/types.js";

/**
 * The eval service loop over fakes (#155): grade → persist → trace → (gated) flywheel feed + moat accrual.
 * No DB, no disk — every side effect is an injected seam.
 */

const SUITE: EvalSuite = {
  agent: "lens",
  version: "1.0.0",
  cases: [
    { id: "m1", prompt: "growth?", kind: "metric", metricId: "growth.score", grader: "provenance", expected: "semantic layer" },
    { id: "s1", prompt: "voice?", kind: "skill", invariant: "house_voice", grader: "contains", expected: "satisfied" },
  ],
};

const SKILL_TEXT = "use the semantic layer. made by robots, steered by humans.";

function build(over: Partial<EvalServiceDeps> & { baselineRate?: number; enabled?: boolean }) {
  const inserted: EvalRunRecord[] = [];
  const traced: string[] = [];
  const regressions: string[] = [];
  const accruals: number[] = [];

  const deps: EvalServiceDeps = {
    store: {
      insert: async (input) => {
        const rec: EvalRunRecord = { id: "r1", createdAt: new Date(0), ...input };
        inserted.push(rec);
        return rec;
      },
    },
    resolveMetric: async () => ({ value: 72, asOfMs: 1000, path: "semantic_layer" }),
    skillText: () => SKILL_TEXT,
    baselineFor: () => ({ agent: "lens", version: "1.0.0", passRate: over.baselineRate ?? 0 }),
    caps: () => ({ enabled: over.enabled ?? true, freshnessMaxAgeMs: 86_400_000, evalRegressionTolerance: 0 }),
    tracer: { logRun: async ({ summary }) => void traced.push(summary.agent) },
    regressionSink: { record: async ({ message }) => void regressions.push(message) },
    moatSink: { accrue: async ({ magnitude }) => void accruals.push(magnitude) },
    now: () => new Date(2000),
    ...over,
  };
  return { service: new EvalService(deps), inserted, traced, regressions, accruals };
}

describe("EvalService.runSuite (#155)", () => {
  it("grades through the real answerer, persists a run, and traces it", async () => {
    const h = build({ baselineRate: 1.0, enabled: false });
    const out = await h.service.runSuite("ws1", SUITE);
    expect(out.summary.passRate).toBe(1); // both cases pass against the fixture + skill text
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({ workspaceId: "ws1", agent: "lens", passed: 2, failed: 0 });
    expect(h.traced).toEqual(["lens"]);
  });

  it("feeds a regression to the flywheel when enabled and below baseline", async () => {
    // Force a regression: baseline 1.0 but break the skill text so the house_voice case fails (0.5 rate).
    const h = build({ baselineRate: 1.0, enabled: true, skillText: () => "no voice here" });
    const out = await h.service.runSuite("ws1", SUITE);
    expect(out.verdict.regressed).toBe(true);
    expect(h.regressions).toHaveLength(1);
    expect(h.regressions[0]).toContain("eval regression");
    expect(h.inserted[0].regressed).toBe(true);
  });

  it("does NOT feed the flywheel when the proactive posture is OFF (records only)", async () => {
    const h = build({ baselineRate: 1.0, enabled: false, skillText: () => "no voice here" });
    const out = await h.service.runSuite("ws1", SUITE);
    expect(out.verdict.regressed).toBe(true);
    expect(h.regressions).toHaveLength(0); // recorded, not escalated
    expect(h.inserted).toHaveLength(1);
  });

  it("accrues to the moat (accumulatedEvals) on a held/improved run when enabled", async () => {
    const h = build({ baselineRate: 0.5, enabled: true });
    await h.service.runSuite("ws1", SUITE);
    expect(h.accruals).toHaveLength(1);
    expect(h.accruals[0]).toBeGreaterThan(0); // passed × passRate
  });
});
