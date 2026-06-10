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
const getTask = vi.fn();
const updateStatus = vi.fn(() => Promise.resolve());

vi.mock("../../src/db/repositories/autonomy.js", () => ({
  getControls,
  getAutonomy,
  listActiveWorkflows,
  incrementActionsUsed,
  bumpWorkflowAction,
  setWorkflowStatus,
  // unused by the start path, but imported by the engine module:
  advanceWorkflowStage: vi.fn(() => Promise.resolve()),
  createApproval: vi.fn(() => Promise.resolve()),
  getApproval: vi.fn(() => Promise.resolve(undefined)),
  decideApproval: vi.fn(() => Promise.resolve(undefined)),
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

function makeLauncher(status: "completed" | "failed" = "completed") {
  const launches: LaunchCall[] = [];
  let seq = 0;
  // `join` stays pending so completion tracking does not run during the launch assertions.
  const launcher = {
    launch: vi.fn((input: LaunchCall) => {
      launches.push(input);
      return Promise.resolve({ id: `sess_${++seq}` });
    }),
    join: vi.fn(() => new Promise<void>(() => {})),
    status: vi.fn(() => Promise.resolve(status)),
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
});
