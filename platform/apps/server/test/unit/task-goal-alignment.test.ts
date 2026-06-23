import { describe, expect, it } from "vitest";
import { assessGoalAlignment } from "../../src/tasks/goal-alignment.js";

describe("task goal alignment (#631)", () => {
  it("names revenue when the task points at paid/customer work", () => {
    expect(
      assessGoalAlignment({
        title: "Follow up with paying prospects",
        description: "Move trial-to-paid conversion this week.",
        labels: [],
        status: "in_progress",
      }),
    ).toEqual({ metric: "revenue", flagged: false, reason: "targets revenue" });
  });

  it("names activation when the task points at first-run/onboarding work", () => {
    expect(
      assessGoalAlignment({
        title: "Fix first-run onboarding",
        description: null,
        labels: ["activation"],
        status: "todo",
      }),
    ).toEqual({ metric: "activation", flagged: false, reason: "targets activation" });
  });

  it("flags active tasks that do not name revenue or activation", () => {
    expect(
      assessGoalAlignment({
        title: "Tidy internal notes",
        description: null,
        labels: ["internal"],
        status: "in_progress",
      }),
    ).toEqual({
      metric: null,
      flagged: true,
      reason: "active task has no explicit revenue or activation target",
    });
  });

  it("does not flag backlog ideas before they become active work", () => {
    expect(
      assessGoalAlignment({ title: "Refactor someday", description: null, labels: [], status: "backlog" }),
    ).toEqual({ metric: null, flagged: false, reason: "no revenue or activation target named yet" });
  });
});
