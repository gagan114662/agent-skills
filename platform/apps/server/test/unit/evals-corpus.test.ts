import { describe, it, expect } from "vitest";
import { listSuiteAgents, loadSuite, loadSkillText, loadBaseline, loadSkillsManifest } from "../../src/evals/loader.js";
import { runSuiteCases } from "../../src/evals/corpus.js";
import { summarizeRun, compareRuns } from "../../src/evals/regression.js";
import type { AnswerContext } from "../../src/evals/corpus.js";
import { marketingAgentSpecs } from "../../src/marketing/blueprint.js";
import { offlineResolve } from "../../src/evals/fixture.js";

/**
 * The eval gate that runs in the normal unit job (#155, ADR-0155 §4). It loads the REAL on-disk suites +
 * skill files and runs them through the deterministic offline answerer, then asserts no agent has dropped
 * below its committed baseline. A skill that drifts (loses a discipline phrase) fails here — a red build,
 * which is the maintenance-as-code latch the playbook calls for.
 *
 * Metric questions are answered against a fixed governed fixture (a fresh semantic-layer value), so the
 * test is deterministic and model-free.
 */

// A deterministic governed resolver: every catalog metric resolves to a fresh semantic-layer value.
const NOW = 1_700_000_000_000;
const ctx: AnswerContext = {
  nowMs: NOW,
  maxAgeMs: 24 * 3600_000,
  resolve: (id) => offlineResolve(id, NOW), // workspace→semantic_layer, venture→raw fallback (matches live)
  skillText: (agent) => loadSkillText(agent),
};

describe("fleet eval gate (#155)", () => {
  const baseline = loadBaseline();
  const agents = listSuiteAgents();

  it("discovers a suite for every fleet agent", () => {
    expect(agents.length).toBe(7);
    expect(agents).toEqual(expect.arrayContaining(["scout", "echo", "quill", "postmark", "bid", "lens", "mark"]));
  });

  it.each(["scout", "echo", "quill", "postmark", "bid", "lens", "mark"])(
    "%s holds its baseline pass-rate",
    (agent) => {
      const suite = loadSuite(agent);
      const summary = summarizeRun(agent, suite.version, runSuiteCases(suite, ctx));
      const verdict = compareRuns(baseline.agents[agent], summary, baseline.tolerance ?? 0);
      if (verdict.regressed) {
        // surface which cases failed for a fast fix
        const failed = summary.results.filter((r) => !r.passed).map((r) => `${r.caseId}: ${r.detail}`);
        throw new Error(`${agent} regressed (${verdict.currentRate} < ${verdict.baselineRate}):\n${failed.join("\n")}`);
      }
      expect(verdict.regressed).toBe(false);
    },
  );

  it("the whole fleet corpus is a few dozen cases", () => {
    const total = agents.reduce((s, a) => s + loadSuite(a).cases.length, 0);
    expect(total).toBeGreaterThanOrEqual(24);
  });
});

describe("skills manifest ↔ blueprint coherence (#155)", () => {
  it("every agent's blueprint skills exist in the manifest (colocation invariant)", () => {
    const manifest = loadSkillsManifest();
    for (const spec of marketingAgentSpecs()) {
      const ids = new Set((manifest.agents[spec.handle]?.skills ?? []).map((s) => s.id));
      expect(ids.size).toBeGreaterThan(0);
      for (const skillId of spec.skills) {
        expect(ids.has(skillId)).toBe(true);
      }
    }
  });
});
