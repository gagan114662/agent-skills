import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionLogger } from "../../src/runtime/manager.js";
import type { AgentWorkflow } from "../../src/db/repositories/autonomy.js";

/**
 * AutonomyEngine launch wiring (#84) — a true unit test with a **fake SessionManager**.
 *
 * The engine is otherwise DB-coupled (it imports its repositories directly), so the persistence
 * layer is mocked here and only the launch behaviour is exercised: a `start` action must `launch()`
 * a real agent session for the stage (channel + agent + task prompt), and the existing guards must
 * block that launch (kill switch, budget). Proves the engine no longer merely narrates.
 */

// --- mocked persistence (only what tick → apply("start") touches) -------------
const getControls = vi.fn();
const getAutonomy = vi.fn();
const listActiveWorkflows = vi.fn();
const incrementActionsUsed = vi.fn(() => Promise.resolve());
const bumpWorkflowAction = vi.fn(() => Promise.resolve());
const setWorkflowStatus = vi.fn(() => Promise.resolve());
const createApproval = vi.fn(() => Promise.resolve({ id: "appr_1" }));
const decideApproval = vi.fn(() => Promise.resolve({ id: "appr_1", status: "approved" }));
const getTask = vi.fn();
const updateStatus = vi.fn(() => Promise.resolve());

vi.mock("../../src/db/repositories/autonomy.js", () => ({
  getControls,
  getAutonomy,
  listActiveWorkflows,
  incrementActionsUsed,
  bumpWorkflowAction,
  setWorkflowStatus,
  createApproval,
  decideApproval,
  // unused by the launch path, but imported by the engine module:
  advanceWorkflowStage: vi.fn(() => Promise.resolve()),
  getApproval: vi.fn(() => Promise.resolve(undefined)),
  getWorkflow: vi.fn(() => Promise.resolve(undefined)),
  listActiveWorkflowWorkspaces: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../src/db/repositories/tasks.js", () => ({
  getTask,
  updateStatus,
  assignTask: vi.fn(() => Promise.resolve()),
  addTaskLink: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/db/repositories/members.js", () => ({
  getWorkspaceMember: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../src/db/repositories/memories.js", () => ({
  upsertMemory: vi.fn(() => Promise.resolve({ id: "mem_1" })),
}));
vi.mock("../../src/observability/metrics.js", () => ({
  recordAutonomyAction: vi.fn(),
  recordAutonomyTick: vi.fn(),
}));

const { AutonomyEngine } = await import("../../src/autonomy/engine.js");

// --- fakes ------------------------------------------------------------------
const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface LaunchCall {
  workspaceId: string;
  channelId: string;
  agentMemberId: string;
  createdByMemberId: string;
  task: string;
}

function makeLauncher(opts: { status?: "completed" | "failed"; joinResolves?: boolean } = {}) {
  const launches: LaunchCall[] = [];
  let seq = 0;
  // By default `join` stays pending so completion tracking does not run during launch assertions;
  // `joinResolves` lets a test drive the session to its terminal status and assert the feedback.
  const launcher = {
    launch: vi.fn((input: LaunchCall) => {
      launches.push(input);
      return Promise.resolve({ id: `sess_${++seq}` });
    }),
    join: vi.fn(() => (opts.joinResolves ? Promise.resolve() : new Promise<void>(() => {}))),
    status: vi.fn(() => Promise.resolve(opts.status ?? "completed")),
  };
  return { launcher, launches };
}

const poster = { post: vi.fn(() => Promise.resolve({ id: "msg_1" })) };

const runningWorkflow: AgentWorkflow = {
  id: "wf_1",
  workspaceId: "ws_1",
  channelId: "ch_1",
  taskId: "task_1",
  stages: [{ agentMemberId: "agent_r", role: "researcher" }],
  currentStage: 0,
  status: "running",
  actionCount: 0,
  createdAt: new Date(0),
};

const enabledAutonomy = {
  id: "au_1",
  agentMemberId: "agent_r",
  enabled: true,
  maxActionsPerTick: 5,
  actionBudget: 100,
  actionsUsed: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  getControls.mockResolvedValue({ workspaceId: "ws_1", killSwitch: false });
  listActiveWorkflows.mockResolvedValue([runningWorkflow]);
  getAutonomy.mockResolvedValue(enabledAutonomy);
  getTask.mockResolvedValue({ id: "task_1", title: "summarize the repo", status: "todo" });
});

describe("AutonomyEngine real-session launch (#84)", () => {
  it("launches a real agent session on a start action (channel + agent + task prompt)", async () => {
    const { launcher, launches } = makeLauncher();
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher });

    const result = await engine.tick("ws_1");

    expect(result.actions.find((a) => a.workflowId === "wf_1")?.action).toBe("start");
    expect(launcher.launch).toHaveBeenCalledTimes(1);
    expect(launches[0]).toMatchObject({
      workspaceId: "ws_1",
      channelId: "ch_1",
      agentMemberId: "agent_r",
    });
    expect(launches[0].task).toContain("summarize the repo");
    // The task was driven to in_progress as part of starting.
    expect(updateStatus).toHaveBeenCalledWith("task_1", "in_progress", "agent_r");
  });

  it("does NOT launch when the kill switch is engaged (guard blocks launch)", async () => {
    getControls.mockResolvedValue({ workspaceId: "ws_1", killSwitch: true });
    const { launcher } = makeLauncher();
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher });

    const result = await engine.tick("ws_1");

    expect(result.killSwitch).toBe(true);
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("does NOT launch when the agent's action budget is exhausted (guard blocks launch)", async () => {
    getAutonomy.mockResolvedValue({ ...enabledAutonomy, actionsUsed: 100, actionBudget: 100 });
    const { launcher } = makeLauncher();
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher });

    const result = await engine.tick("ws_1");

    const action = result.actions.find((a) => a.workflowId === "wf_1");
    expect(action?.action).toBe("noop");
    expect(action?.reason).toBe("budget_exhausted");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("on a completed final-stage session, requests approval — it never drives the task to done", async () => {
    const { launcher } = makeLauncher({ status: "completed", joinResolves: true });
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher });

    await engine.tick("ws_1");
    await engine.drain(); // let the completion tracker run

    // The completion is parked at the human gate, not auto-completed.
    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "wf_1", taskId: "task_1", action: "complete_workflow" }),
    );
    expect(setWorkflowStatus).toHaveBeenCalledWith("wf_1", "awaiting_approval");
    // The only status write was the `in_progress` on start — never `done`.
    expect(updateStatus).toHaveBeenCalledWith("task_1", "in_progress", "agent_r");
    expect(updateStatus).not.toHaveBeenCalledWith("task_1", "done", expect.anything());
  });

  it("on a failed session, blocks the task (no approval gate for work that did not land)", async () => {
    // First getTask (tick) sees `todo` → start; the tracker's getTask sees `in_progress` → blocked.
    getTask.mockReset();
    getTask.mockResolvedValueOnce({ id: "task_1", title: "summarize the repo", status: "todo" });
    getTask.mockResolvedValue({ id: "task_1", title: "summarize the repo", status: "in_progress" });
    const { launcher } = makeLauncher({ status: "failed", joinResolves: true });
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher });

    await engine.tick("ws_1");
    await engine.drain();

    expect(createApproval).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith("task_1", "blocked", "agent_r");
  });
});

describe("AutonomyEngine auto-approve policy (#84 follow-up, ADR-0042)", () => {
  // The completed task is in_progress when the session settles (set on `start`).
  beforeEach(() => {
    getTask.mockReset();
    getTask.mockResolvedValueOnce({ id: "task_1", title: "summarize the repo", status: "todo" });
    getTask.mockResolvedValue({ id: "task_1", title: "summarize the repo", status: "in_progress" });
  });

  it("with NO autonomy.complete rule wired, parks at the human gate — exactly as today", async () => {
    const { launcher } = makeLauncher({ status: "completed", joinResolves: true });
    // A policy source is wired but returns no rule for this workspace.
    const engine = new AutonomyEngine({
      poster,
      logger: silentLogger,
      launcher,
      completionPolicies: () => Promise.resolve([]),
    });

    await engine.tick("ws_1");
    await engine.drain();

    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(setWorkflowStatus).toHaveBeenCalledWith("wf_1", "awaiting_approval");
    expect(decideApproval).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith("task_1", "done", expect.anything());
    expect(setWorkflowStatus).not.toHaveBeenCalledWith("wf_1", "completed");
  });

  it("with an auto-approve rule, drives completed → done and records which rule fired", async () => {
    const { launcher } = makeLauncher({ status: "completed", joinResolves: true });
    const completionPolicies = vi.fn(() =>
      Promise.resolve([
        { id: "rule_auto", actionType: "autonomy.complete", requiresApproval: false, maxAutoAmount: null },
      ]),
    );
    const engine = new AutonomyEngine({ poster, logger: silentLogger, launcher, completionPolicies });

    await engine.tick("ws_1");
    await engine.drain();

    // The policy is consulted for THIS workspace (no cross-tenant leakage).
    expect(completionPolicies).toHaveBeenCalledWith("ws_1");
    // The approval is still created (the gate artifact) but immediately decided by policy.
    expect(createApproval).toHaveBeenCalledTimes(1);
    expect(decideApproval).toHaveBeenCalledWith(
      "appr_1",
      expect.objectContaining({ status: "approved", decisionSource: "policy", policyRuleId: "rule_auto" }),
    );
    // The loop closes to done + completed without a human.
    expect(updateStatus).toHaveBeenCalledWith("task_1", "done", "agent_r");
    expect(setWorkflowStatus).toHaveBeenCalledWith("wf_1", "completed");
    expect(setWorkflowStatus).not.toHaveBeenCalledWith("wf_1", "awaiting_approval");
  });

  it("with a rule that still requires approval, keeps the human gate", async () => {
    const { launcher } = makeLauncher({ status: "completed", joinResolves: true });
    const engine = new AutonomyEngine({
      poster,
      logger: silentLogger,
      launcher,
      completionPolicies: () =>
        Promise.resolve([
          { id: "rule_gate", actionType: "autonomy.complete", requiresApproval: true, maxAutoAmount: null },
        ]),
    });

    await engine.tick("ws_1");
    await engine.drain();

    expect(setWorkflowStatus).toHaveBeenCalledWith("wf_1", "awaiting_approval");
    expect(decideApproval).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalledWith("task_1", "done", expect.anything());
  });
});
