import { describe, it, expect } from "vitest";
import { decideWorkflowAction, type WorkflowState } from "../../src/autonomy/decide.js";
import type { TaskStatus } from "../../src/tasks/status.js";

/** A two-stage workflow on its first stage, by default. */
function wf(over: Partial<WorkflowState> = {}): WorkflowState {
  return { status: "running", currentStage: 0, stageCount: 2, actionCount: 0, ...over };
}

function decide(task: TaskStatus, over: Partial<WorkflowState> = {}, flags = {}) {
  return decideWorkflowAction({
    task: { status: task },
    workflow: wf(over),
    killSwitch: false,
    budgetExhausted: false,
    ...flags,
  });
}

describe("decideWorkflowAction (#17)", () => {
  it("starts an unstarted task (todo/backlog → start)", () => {
    expect(decide("todo").action).toBe("start");
    expect(decide("backlog").action).toBe("start");
  });

  it("hands off when there are more stages (in_progress, not last stage)", () => {
    const d = decide("in_progress", { currentStage: 0, stageCount: 2 });
    expect(d.action).toBe("handoff");
    expect(d.reason).toBe("more_stages");
  });

  it("requests approval on the final stage (in_progress, last stage)", () => {
    const d = decide("in_progress", { currentStage: 1, stageCount: 2 });
    expect(d.action).toBe("request_approval");
    expect(d.reason).toBe("final_stage");
  });

  it("a single-stage workflow goes straight to approval once started", () => {
    expect(decide("in_progress", { currentStage: 0, stageCount: 1 }).action).toBe(
      "request_approval",
    );
  });

  it("the kill switch wins over everything (immediate halt)", () => {
    const d = decide("todo", {}, { killSwitch: true });
    expect(d.action).toBe("noop");
    expect(d.reason).toBe("kill_switch");
  });

  it("an exhausted cost budget stops new actions", () => {
    const d = decide("todo", {}, { budgetExhausted: true });
    expect(d).toEqual({ action: "noop", reason: "budget_exhausted" });
  });

  it("the loop guard stops a churning workflow", () => {
    const d = decideWorkflowAction({
      task: { status: "in_progress" },
      workflow: wf({ actionCount: 3 }),
      killSwitch: false,
      budgetExhausted: false,
      loopGuardMax: 3,
    });
    expect(d).toEqual({ action: "noop", reason: "loop_guard" });
  });

  it("a workflow awaiting approval is inert (the human gate)", () => {
    expect(decide("in_progress", { status: "awaiting_approval", currentStage: 1 }).action).toBe(
      "noop",
    );
  });

  it("completed/canceled workflows and terminal tasks are inert", () => {
    expect(decide("in_progress", { status: "completed" }).reason).toBe("workflow_completed");
    expect(decide("done").reason).toBe("task_terminal");
    expect(decide("canceled").reason).toBe("task_terminal");
    expect(decide("blocked").reason).toBe("task_blocked");
  });

  it("a workflow with no stages does nothing", () => {
    expect(decide("todo", { stageCount: 0 }).reason).toBe("no_stages");
  });

  it("guards take precedence over progress (kill switch beats a startable task)", () => {
    expect(decide("in_progress", { currentStage: 0 }, { killSwitch: true }).action).toBe("noop");
  });
});
