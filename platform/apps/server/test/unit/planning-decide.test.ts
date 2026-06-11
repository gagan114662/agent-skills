import { describe, it, expect } from "vitest";
import { decidePlanningDispatch, type PlanningDispatchInput } from "../../src/planning/decide.js";

/** A clean auto-dispatchable input; override one field per test to exercise a branch. */
function input(over: Partial<PlanningDispatchInput> = {}): PlanningDispatchInput {
  return {
    isPivot: false,
    overEffortBudget: false,
    autoAllowed: true,
    budgetExhausted: false,
    killSwitchEngaged: false,
    ...over,
  };
}

describe("decidePlanningDispatch: route-first, spend caps gate the auto path only", () => {
  it("auto-dispatches a small, policy-allowed, in-budget item with the kill switch off", () => {
    expect(decidePlanningDispatch(input())).toEqual({ action: "auto", reason: "auto_dispatch" });
  });

  it("gates a pivot for human approval — sensitive-by-default, even when everything else allows auto", () => {
    expect(
      decidePlanningDispatch(input({ isPivot: true, budgetExhausted: true, killSwitchEngaged: true })),
    ).toEqual({ action: "gate", reason: "pivot_requires_approval" });
  });

  it("gates an over-budget effort (effort above the auto-flow ceiling) for human approval", () => {
    expect(decidePlanningDispatch(input({ overEffortBudget: true }))).toEqual({
      action: "gate",
      reason: "over_budget_effort",
    });
  });

  it("gates a class no #95 policy rule auto-allows (sensitive-by-default)", () => {
    expect(decidePlanningDispatch(input({ autoAllowed: false }))).toEqual({
      action: "gate",
      reason: "policy_requires_approval",
    });
  });

  it("routes (gate) BEFORE the spend caps — queueing a human consumes no budget", () => {
    // budget exhausted AND not auto-allowed → the policy gate wins (a human queue, not a skip).
    expect(
      decidePlanningDispatch(input({ autoAllowed: false, budgetExhausted: true })),
    ).toEqual({ action: "gate", reason: "policy_requires_approval" });
  });

  it("skips (auto path only) when the kill switch is engaged", () => {
    expect(decidePlanningDispatch(input({ killSwitchEngaged: true }))).toEqual({
      action: "skip",
      reason: "kill_switch",
    });
  });

  it("skips (auto path only) when the tenant budget is exhausted", () => {
    expect(decidePlanningDispatch(input({ budgetExhausted: true }))).toEqual({
      action: "skip",
      reason: "budget_exhausted",
    });
  });

  it("kill switch takes precedence over budget on the auto path", () => {
    expect(
      decidePlanningDispatch(input({ killSwitchEngaged: true, budgetExhausted: true })),
    ).toEqual({ action: "skip", reason: "kill_switch" });
  });
});
