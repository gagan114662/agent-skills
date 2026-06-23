/**
 * Unit tests for the PURE planning core of issue #590 (`planSchedule`). Covers dependency ordering, the
 * blocked-until-approved guarantee for outbound tasks, gate-vs-ordinary satisfaction, the fail-closed ungated
 * outbound guard, missing/failed upstreams, cycle handling, and determinism.
 */

import { describe, it, expect } from "vitest";
import { planSchedule, nextRunnable, isRunnable, isSatisfied } from "../../src/dependency-scheduler/plan.js";
import { DEPENDENCY_SCHEDULER_DEFAULTS, type DependencySchedulerCaps } from "../../src/dependency-scheduler/caps.js";
import type { ScheduledTask, TaskKind, TaskStatus } from "../../src/dependency-scheduler/types.js";

const CAPS: DependencySchedulerCaps = { ...DEPENDENCY_SCHEDULER_DEFAULTS };

function t(
  id: string,
  kind: TaskKind,
  status: TaskStatus,
  dependsOn: string[] = [],
  over: Partial<ScheduledTask> = {},
): ScheduledTask {
  return { id, workspaceId: "ws", kind, status, dependsOn, ...over };
}

function blockOf(plan: ReturnType<typeof planSchedule>, id: string) {
  return plan.blocked.find((b) => b.taskId === id);
}

describe("planSchedule — pure dependency planner (#590)", () => {
  it("ORDERING: a pending task with no dependencies is runnable", () => {
    const plan = planSchedule([t("draft", "draft", "pending")], CAPS);
    expect(plan.runnable).toEqual(["draft"]);
    expect(plan.blocked).toEqual([]);
  });

  it("BLOCKED-UNTIL-APPROVED: an outbound task waits while its review gate is pending, then unblocks on approval", () => {
    const draft = t("draft", "draft", "completed");
    const review = t("review", "review", "pending", ["draft"]);
    const publish = t("publish", "publish", "pending", ["review"]);

    // review is runnable (draft completed); publish is blocked behind a not-yet-approved gate.
    const p1 = planSchedule([draft, review, publish], CAPS);
    expect(p1.runnable).toEqual(["review"]);
    expect(blockOf(p1, "publish")?.reason).toBe("waiting_on_upstream");
    expect(blockOf(p1, "publish")?.blockedBy).toEqual(["review"]);
    expect(blockOf(p1, "publish")?.permanent).toBe(false);

    // While the gate is merely RUNNING, publish is still blocked — content is not approved yet.
    const p2 = planSchedule([draft, { ...review, status: "running" }, publish], CAPS);
    expect(p2.runnable).toEqual([]);
    expect(blockOf(p2, "publish")?.reason).toBe("waiting_on_upstream");

    // Once the gate is APPROVED, publish becomes runnable.
    const p3 = planSchedule([draft, { ...review, status: "approved" }, publish], CAPS);
    expect(p3.runnable).toEqual(["publish"]);
    expect(p3.done).toContain("review");
  });

  it("GATE SATISFACTION: a gate that is only `completed` does NOT clear its dependents (gates need `approved`)", () => {
    const review = t("review", "review", "completed");
    const publish = t("publish", "publish", "pending", ["review"]);
    const plan = planSchedule([review, publish], CAPS);
    // `completed` review is neither a satisfying gate nor dead → publish keeps waiting.
    expect(plan.runnable).toEqual([]);
    expect(blockOf(plan, "publish")?.reason).toBe("waiting_on_upstream");
  });

  it("ORDINARY SATISFACTION: a non-gate dependency is satisfied by `completed`", () => {
    const a = t("a", "task", "completed");
    const b = t("b", "task", "pending", ["a"]);
    const plan = planSchedule([a, b], CAPS);
    expect(plan.runnable).toEqual(["b"]);
  });

  it("REJECTED GATE: a rejected review permanently blocks the outbound task (content must not go out)", () => {
    const review = t("review", "review", "rejected");
    const publish = t("publish", "publish", "pending", ["review"]);
    const plan = planSchedule([review, publish], CAPS);
    expect(plan.runnable).toEqual([]);
    expect(plan.failed).toContain("review");
    expect(blockOf(plan, "publish")?.reason).toBe("upstream_failed");
    expect(blockOf(plan, "publish")?.permanent).toBe(true);
  });

  it("UNGATED OUTBOUND: an outbound task with no gate dependency is fail-closed blocked", () => {
    const publish = t("publish", "publish", "pending", []);
    const plan = planSchedule([publish], CAPS);
    expect(plan.runnable).toEqual([]);
    expect(blockOf(plan, "publish")?.reason).toBe("ungated_outbound");
    expect(blockOf(plan, "publish")?.permanent).toBe(true);
  });

  it("UNGATED OUTBOUND: a non-gate upstream does NOT count as a gate — still fail-closed", () => {
    const draft = t("draft", "draft", "completed");
    const publish = t("publish", "publish", "pending", ["draft"]); // depends only on ordinary work
    const plan = planSchedule([draft, publish], CAPS);
    expect(blockOf(plan, "publish")?.reason).toBe("ungated_outbound");
  });

  it("UNGATED OUTBOUND can be disabled via caps (then a satisfied ordinary dep makes it runnable)", () => {
    const draft = t("draft", "draft", "completed");
    const publish = t("publish", "publish", "pending", ["draft"]);
    const plan = planSchedule([draft, publish], { ...CAPS, requireGateForOutbound: false });
    expect(plan.runnable).toEqual(["publish"]);
  });

  it("MISSING DEPENDENCY: a dangling dependency id fails closed", () => {
    const publish = t("publish", "publish", "pending", ["ghost-review"]);
    const plan = planSchedule([publish], CAPS);
    expect(plan.runnable).toEqual([]);
    const b = blockOf(plan, "publish");
    // No real gate among deps AND the dep is missing — the ungated guard fires first, also fail-closed.
    expect(b?.permanent).toBe(true);
    expect(["ungated_outbound", "missing_dependency"]).toContain(b?.reason);
  });

  it("MISSING DEPENDENCY on a non-outbound task is reported as missing_dependency", () => {
    const task = t("send-internal", "task", "pending", ["ghost"]);
    const plan = planSchedule([task], CAPS);
    expect(blockOf(plan, "send-internal")?.reason).toBe("missing_dependency");
    expect(blockOf(plan, "send-internal")?.blockedBy).toEqual(["ghost"]);
  });

  it("CYCLE: a two-node cycle is detected and both nodes are blocked, never runnable", () => {
    const a = t("a", "task", "pending", ["b"]);
    const b = t("b", "task", "pending", ["a"]);
    const plan = planSchedule([a, b], CAPS);
    expect(plan.cyclic.sort()).toEqual(["a", "b"]);
    expect(plan.runnable).toEqual([]);
    expect(blockOf(plan, "a")?.reason).toBe("dependency_cycle");
    expect(blockOf(plan, "b")?.reason).toBe("dependency_cycle");
  });

  it("CYCLE: a self-dependency is a one-node cycle", () => {
    const a = t("a", "task", "pending", ["a"]);
    const plan = planSchedule([a], CAPS);
    expect(plan.cyclic).toEqual(["a"]);
    expect(blockOf(plan, "a")?.reason).toBe("dependency_cycle");
  });

  it("CYCLE: a task outside the cycle but depending on it is still schedulable on its own merits", () => {
    // a <-> b cycle; c depends on a completed task d, so c is runnable independent of the cycle.
    const a = t("a", "task", "pending", ["b"]);
    const b = t("b", "task", "pending", ["a"]);
    const d = t("d", "task", "completed");
    const c = t("c", "task", "pending", ["d"]);
    const plan = planSchedule([a, b, c, d], CAPS);
    expect(plan.cyclic.sort()).toEqual(["a", "b"]);
    expect(plan.runnable).toEqual(["c"]);
  });

  it("PRIORITY: among simultaneously runnable tasks, higher priority comes first, ties broken by id", () => {
    const lo = t("z-low", "task", "pending", [], { priority: 1 });
    const hi = t("a-high", "task", "pending", [], { priority: 5 });
    const mid1 = t("m1", "task", "pending", [], { priority: 3 });
    const mid2 = t("m0", "task", "pending", [], { priority: 3 });
    const plan = planSchedule([lo, hi, mid1, mid2], CAPS);
    expect(plan.runnable).toEqual(["a-high", "m0", "m1", "z-low"]);
    expect(nextRunnable(plan)).toBe("a-high");
  });

  it("DETERMINISM: input order does not change the plan", () => {
    const tasks = [
      t("draft", "draft", "completed"),
      t("review", "review", "approved", ["draft"]),
      t("publish", "publish", "pending", ["review"]),
      t("post", "post", "pending", ["review"]),
    ];
    const forward = planSchedule(tasks, CAPS);
    const reversed = planSchedule([...tasks].reverse(), CAPS);
    expect(reversed).toEqual(forward);
    expect(forward.runnable).toEqual(["post", "publish"]); // both gated by an approved review, id-ordered
  });

  it("PARTITIONS: done and failed are reported separately from the pending graph", () => {
    const plan = planSchedule(
      [
        t("done1", "task", "completed"),
        t("done2", "approval", "approved"),
        t("bad1", "review", "rejected"),
        t("bad2", "task", "failed"),
        t("bad3", "task", "cancelled"),
        t("go", "task", "pending"),
      ],
      CAPS,
    );
    expect(plan.done.sort()).toEqual(["done1", "done2"]);
    expect(plan.failed.sort()).toEqual(["bad1", "bad2", "bad3"]);
    expect(plan.runnable).toEqual(["go"]);
  });

  it("throws on duplicate task ids (a programming error, not a schedule state)", () => {
    expect(() => planSchedule([t("x", "task", "pending"), t("x", "task", "pending")], CAPS)).toThrow(/duplicate/);
  });

  it("isSatisfied / isRunnable helpers reflect the core rules", () => {
    expect(isSatisfied(t("g", "review", "approved"))).toBe(true);
    expect(isSatisfied(t("g", "review", "completed"))).toBe(false);
    expect(isSatisfied(t("o", "task", "completed"))).toBe(true);
    const plan = planSchedule([t("go", "task", "pending")], CAPS);
    expect(isRunnable(plan, "go")).toBe(true);
    expect(isRunnable(plan, "nope")).toBe(false);
  });
});
