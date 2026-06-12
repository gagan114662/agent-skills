import { describe, it, expect } from "vitest";
import { evaluateConditions, evaluateOne, resolveFact } from "../../src/workflows/conditions.js";
import { decideWorkflowRun } from "../../src/workflows/decide.js";
import { resolveWorkflowCaps, WORKFLOW_DEFAULTS } from "../../src/workflows/caps.js";
import { buildCatalogFacts } from "../../src/workflows/facts.js";
import { aggregateWorkflowInsights } from "../../src/workflows/insights.js";
import type { WorkflowCondition, WorkflowRun, WorkflowRunDecisionInput } from "../../src/workflows/types.js";
import type { CatalogEntry } from "../../src/catalog/types.js";

describe("workflows conditions (#152)", () => {
  it("resolveFact walks a dot-path and returns undefined for a missing segment", () => {
    const facts = { catalog: { site: { active: 2 } } };
    expect(resolveFact(facts, "catalog.site.active")).toBe(2);
    expect(resolveFact(facts, "catalog.site.missing")).toBeUndefined();
    expect(resolveFact(facts, "catalog.nope.active")).toBeUndefined();
    expect(resolveFact(facts, "")).toBeUndefined();
  });

  it("evaluateOne handles each operator", () => {
    expect(evaluateOne("eq", "active", "active")).toBe(true);
    expect(evaluateOne("eq", 3, "3")).toBe(true); // string/number coercion
    expect(evaluateOne("neq", "active", "archived")).toBe(true);
    expect(evaluateOne("gt", 5, 3)).toBe(true);
    expect(evaluateOne("gte", 3, 3)).toBe(true);
    expect(evaluateOne("lt", 2, 3)).toBe(true);
    expect(evaluateOne("lte", 3, 3)).toBe(true);
    expect(evaluateOne("contains", "ipop.ai", "pop")).toBe(true);
    expect(evaluateOne("exists", 0, undefined)).toBe(true);
    expect(evaluateOne("exists", undefined, undefined)).toBe(false);
  });

  it("ordered ops are false against non-numeric or missing facts", () => {
    expect(evaluateOne("gt", undefined, 3)).toBe(false);
    expect(evaluateOne("gt", "notanumber", 3)).toBe(false);
  });

  it("an empty condition list is vacuously met", () => {
    expect(evaluateConditions([], {})).toEqual({ met: true, failedIndex: null });
  });

  it("ANDs the list and reports the first failed index", () => {
    const facts = { catalog: { site: { active: 1 }, venture: { count: 0 } } };
    const conditions: WorkflowCondition[] = [
      { fact: "catalog.site.active", op: "gte", value: 1 }, // passes
      { fact: "catalog.venture.count", op: "gt", value: 0 }, // fails (index 1)
    ];
    expect(evaluateConditions(conditions, facts)).toEqual({ met: false, failedIndex: 1 });
  });

  it("all conditions met ⇒ met:true", () => {
    const facts = { metrics: { signups: 150 } };
    const conditions: WorkflowCondition[] = [{ fact: "metrics.signups", op: "gt", value: 100 }];
    expect(evaluateConditions(conditions, facts)).toEqual({ met: true, failedIndex: null });
  });
});

describe("workflows decide (#152)", () => {
  const base: WorkflowRunDecisionInput = {
    capsEnabled: true,
    workflowEnabled: true,
    killSwitch: false,
    due: true,
    conditionsMet: true,
    runsInWindow: 0,
    maxRunsPerWindow: 50,
  };

  it("runs when enabled, due, conditions met, and under the rate cap", () => {
    expect(decideWorkflowRun(base)).toEqual({ action: "run", reason: "conditions_met" });
  });

  it("skips in ladder order: caps → workflow → kill → due → conditions → rate", () => {
    expect(decideWorkflowRun({ ...base, capsEnabled: false }).reason).toBe("workflows_disabled");
    expect(decideWorkflowRun({ ...base, workflowEnabled: false }).reason).toBe("workflow_disabled");
    expect(decideWorkflowRun({ ...base, killSwitch: true }).reason).toBe("kill_switch");
    expect(decideWorkflowRun({ ...base, due: false }).reason).toBe("not_due");
    expect(decideWorkflowRun({ ...base, conditionsMet: false }).reason).toBe("conditions_unmet");
    expect(decideWorkflowRun({ ...base, runsInWindow: 50, maxRunsPerWindow: 50 }).reason).toBe("rate_limited");
  });

  it("caps disabled wins even when everything else would block too", () => {
    expect(
      decideWorkflowRun({ ...base, capsEnabled: false, workflowEnabled: false, killSwitch: true, due: false }).reason,
    ).toBe("workflows_disabled");
  });
});

describe("workflows caps (#152)", () => {
  it("defaults to OFF with a per-day window", () => {
    expect(resolveWorkflowCaps(undefined)).toEqual(WORKFLOW_DEFAULTS);
    expect(resolveWorkflowCaps(undefined).enabled).toBe(false);
    expect(resolveWorkflowCaps(undefined).windowMinutes).toBe(1440);
  });

  it("an explicit config overrides only the set fields", () => {
    const caps = resolveWorkflowCaps({ enabled: true, maxRunsPerWindow: 5 });
    expect(caps.enabled).toBe(true);
    expect(caps.maxRunsPerWindow).toBe(5);
    expect(caps.windowMinutes).toBe(WORKFLOW_DEFAULTS.windowMinutes);
    expect(caps.maxActionsPerRun).toBe(WORKFLOW_DEFAULTS.maxActionsPerRun);
  });
});

describe("workflows facts (#152)", () => {
  function entry(kind: CatalogEntry["kind"], status: CatalogEntry["status"]): CatalogEntry {
    return {
      id: "x",
      workspaceId: "w",
      kind,
      name: "n",
      identifier: "",
      status,
      provenance: "manual",
      ownerMemberId: null,
      metadata: {},
      createdByMemberId: "m",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("rolls catalog entries up into per-kind status counts", () => {
    const facts = buildCatalogFacts([
      entry("site", "active"),
      entry("site", "archived"),
      entry("venture", "active"),
    ]);
    const catalog = facts.catalog as Record<string, Record<string, number>>;
    expect(catalog.total).toBe(3);
    expect(catalog.site).toEqual({ count: 2, active: 1, inactive: 0, pending: 0, archived: 1 });
    expect(catalog.venture).toEqual({ count: 1, active: 1, inactive: 0, pending: 0, archived: 0 });
    // a condition over the facts evaluates as expected
    expect(evaluateConditions([{ fact: "catalog.site.active", op: "gte", value: 1 }], facts).met).toBe(true);
    expect(evaluateConditions([{ fact: "catalog.venture.archived", op: "gt", value: 0 }], facts).met).toBe(false);
  });

  it("exposes the injected metrics bag", () => {
    const facts = buildCatalogFacts([], { signups: 200 });
    expect(evaluateConditions([{ fact: "metrics.signups", op: "gt", value: 100 }], facts).met).toBe(true);
  });
});

describe("workflows insights (#152)", () => {
  function run(status: WorkflowRun["status"], reason: string, createdAt: Date): WorkflowRun {
    return { id: "r", workspaceId: "w", workflowId: "wf", trigger: "schedule", status, reason, results: [], createdAt };
  }
  const now = new Date("2026-06-12T12:00:00.000Z");

  it("counts by status and computes a success rate excluding skips", () => {
    const runs = [
      run("fired", "conditions_met", now),
      run("fired", "conditions_met", now),
      run("failed", "agent_task:boom", now),
      run("skipped", "not_due", now),
      run("blocked", "agent_not_seeded", now),
    ];
    const insights = aggregateWorkflowInsights(runs, now);
    expect(insights.total).toBe(5);
    expect(insights.byStatus).toEqual({ fired: 2, failed: 1, skipped: 1, blocked: 1 });
    // 2 fired / (2 fired + 1 failed + 1 blocked) = 0.5
    expect(insights.successRate).toBe(0.5);
    expect(insights.recentFailureReasons).toEqual(["agent_task:boom"]);
  });

  it("returns 0 success rate with no attempts", () => {
    expect(aggregateWorkflowInsights([run("skipped", "not_due", now)], now).successRate).toBe(0);
  });

  it("buckets fired/failed by UTC day, oldest first", () => {
    const yesterday = new Date("2026-06-11T09:00:00.000Z");
    const insights = aggregateWorkflowInsights([run("fired", "ok", yesterday), run("failed", "boom", now)], now, 2);
    expect(insights.daily).toEqual([
      { date: "2026-06-11", fired: 1, failed: 0, blocked: 0 },
      { date: "2026-06-12", fired: 0, failed: 1, blocked: 0 },
    ]);
  });
});
