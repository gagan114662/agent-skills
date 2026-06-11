import { describe, it, expect } from "vitest";
import { gradeCase } from "../../src/evals/grade.js";
import { summarizeRun, compareRuns, verdictRow } from "../../src/evals/regression.js";
import { answerCase, parseSuite, runSuiteCases, SKILL_INVARIANTS } from "../../src/evals/corpus.js";
import type { AnswerContext } from "../../src/evals/corpus.js";
import type { EvalCase } from "../../src/evals/types.js";

const c = (over: Partial<EvalCase>): EvalCase => ({
  id: "c1",
  prompt: "q",
  kind: "metric",
  grader: "contains",
  expected: "",
  ...over,
});

describe("graders (#155)", () => {
  it("exact / contains fold case + trim", () => {
    expect(gradeCase(c({ grader: "exact", expected: "Yes" }), "  yes ").passed).toBe(true);
    expect(gradeCase(c({ grader: "contains", expected: "canonical" }), "the canonical number").passed).toBe(true);
    expect(gradeCase(c({ grader: "contains", expected: "nope" }), "abc").passed).toBe(false);
  });

  it("numeric grader respects tolerance and reads the first number", () => {
    expect(gradeCase(c({ grader: "numeric", expected: "72", tolerance: 0.5 }), "score: 72.3/100").passed).toBe(true);
    expect(gradeCase(c({ grader: "numeric", expected: "72", tolerance: 0.1 }), "72.3/100").passed).toBe(false);
    expect(gradeCase(c({ grader: "numeric", expected: "5" }), "no numbers here").passed).toBe(false);
  });

  it("regex grader fails closed on a bad pattern", () => {
    expect(gradeCase(c({ grader: "regex", expected: "fall(back)?" }), "FALLBACK path").passed).toBe(true);
    expect(gradeCase(c({ grader: "regex", expected: "(" }), "anything").passed).toBe(false);
  });

  it("provenance grader checks the answer cites its path", () => {
    expect(gradeCase(c({ grader: "provenance", expected: "semantic layer" }), "via semantic layer (canonical)").passed).toBe(true);
    expect(gradeCase(c({ grader: "provenance", expected: "stale" }), "fresh and clean").passed).toBe(false);
  });

  it("an unknown grader fails with a reason", () => {
    const r = gradeCase(c({ grader: "bogus" as never }), "x");
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("unknown grader");
  });
});

describe("regression math (#155)", () => {
  const results = [
    { caseId: "a", passed: true, actual: "", detail: "" },
    { caseId: "b", passed: true, actual: "", detail: "" },
    { caseId: "c", passed: false, actual: "", detail: "x" },
  ];

  it("summarizeRun computes pass rate", () => {
    const s = summarizeRun("lens", "1", results);
    expect(s).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(summarizeRun("lens", "1", []).passRate).toBe(0);
  });

  it("compareRuns flags a real regression but tolerates noise; first run never regresses", () => {
    const cur = summarizeRun("lens", "1", results); // 0.667
    const worse = compareRuns({ agent: "lens", version: "1", passRate: 1.0 }, cur, 0);
    expect(worse.regressed).toBe(true);
    expect(worse.delta).toBeLessThan(0);

    const within = compareRuns({ agent: "lens", version: "1", passRate: 0.7 }, cur, 0.05);
    expect(within.regressed).toBe(false);

    const firstRun = compareRuns(undefined, cur, 0);
    expect(firstRun.regressed).toBe(false);
    expect(firstRun.improved).toBe(true);
  });

  it("verdictRow renders a markdown row with a status glyph", () => {
    const row = verdictRow(compareRuns({ agent: "lens", version: "1", passRate: 1 }, summarizeRun("lens", "1", results), 0));
    expect(row).toContain("| lens |");
    expect(row).toContain("🔴");
  });
});

describe("corpus answerer (#155)", () => {
  const ctx: AnswerContext = {
    nowMs: 1_000_000,
    maxAgeMs: 60_000,
    resolve: (id) =>
      id === "growth.score"
        ? { value: 72, asOfMs: 1_000_000 - 1000, path: "semantic_layer" }
        : { value: null, asOfMs: null, path: "raw_data" },
    skillText: (agent) =>
      agent === "lens"
        ? "consult governed sources before raw. use the semantic layer. flag any fallback. cite provenance and freshness. made by robots, steered by humans."
        : "thin content",
  };

  it("routes a metric case through the real semantic layer (one number, cited)", () => {
    const ans = answerCase("lens", c({ kind: "metric", metricId: "growth.score" }), ctx);
    expect(ans).toContain("72/100");
    expect(ans).toContain("semantic layer (canonical)");
  });

  it("answers a skill-invariant case from the agent's loaded skill text", () => {
    expect(answerCase("lens", c({ kind: "skill", invariant: "uses_semantic_layer" }), ctx)).toContain("satisfied");
    const miss = answerCase("scout", c({ kind: "skill", invariant: "uses_semantic_layer" }), ctx);
    expect(miss).toContain("missing");
    expect(miss).not.toContain("satisfied"); // a failing invariant must NOT fool a `contains "satisfied"` grader
  });

  it("runSuiteCases grades a whole suite; lens scores 100% on its own disciplines", () => {
    const suite = parseSuite({
      agent: "lens",
      version: "1",
      cases: [
        { id: "m1", prompt: "growth?", kind: "metric", metricId: "growth.score", grader: "provenance", expected: "semantic layer" },
        { id: "s1", prompt: "rule?", kind: "skill", invariant: "consults_governed_first", grader: "contains", expected: "satisfied" },
        { id: "s2", prompt: "voice?", kind: "skill", invariant: "house_voice", grader: "contains", expected: "satisfied" },
      ],
    });
    const summary = summarizeRun(suite.agent, suite.version, runSuiteCases(suite, ctx));
    expect(summary.passRate).toBe(1);
  });

  it("parseSuite rejects malformed suites", () => {
    expect(() => parseSuite({ version: "1", cases: [] })).toThrow(/agent/);
    expect(() => parseSuite({ agent: "x", version: "1", cases: [{ id: "a", prompt: "p", kind: "bad", grader: "exact", expected: "" }] })).toThrow(/metric\|skill/);
    expect(() => parseSuite({ agent: "x", version: "1", cases: [{ id: "a", prompt: "p", kind: "skill", grader: "nope", expected: "" }] })).toThrow(/grader/);
  });

  it("every named invariant is a function (no typos in the registry)", () => {
    for (const k of Object.keys(SKILL_INVARIANTS)) expect(typeof SKILL_INVARIANTS[k]).toBe("function");
  });
});
