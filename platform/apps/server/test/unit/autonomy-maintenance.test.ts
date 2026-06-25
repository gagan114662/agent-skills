import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionLogger } from "../../src/runtime/manager.js";

/**
 * Maintenance pauses the autonomy loop (#99). When the platform is in maintenance, `tickAll()` must
 * short-circuit BEFORE touching the DB — no workspace listing, no per-workflow work. The flag is the
 * same Redis switch the HTTP write-gate reads, injected here as `maintenancePaused`.
 */

const listActiveWorkflowWorkspaces = vi.fn(() => Promise.resolve(["ws_1", "ws_2"]));

vi.mock("../../src/db/repositories/autonomy.js", () => ({
  listActiveWorkflowWorkspaces,
  // imported by the engine module but unused on the maintenance short-circuit path:
  getControls: vi.fn(),
  getAutonomy: vi.fn(),
  listActiveWorkflows: vi.fn(() => Promise.resolve([])),
  tryReserveActionsUsed: vi.fn(() => Promise.resolve(true)),
  refundActionsUsed: vi.fn(() => Promise.resolve()),
  bumpWorkflowAction: vi.fn(() => Promise.resolve()),
  attachWorkflowSession: vi.fn(() => Promise.resolve(true)),
  clearWorkflowSession: vi.fn(() => Promise.resolve()),
  setWorkflowStatus: vi.fn(() => Promise.resolve()),
  createApproval: vi.fn(() => Promise.resolve({ id: "appr_1" })),
  decideApproval: vi.fn(() => Promise.resolve(undefined)),
  advanceWorkflowStage: vi.fn(() => Promise.resolve()),
  getApproval: vi.fn(() => Promise.resolve(undefined)),
  getWorkflow: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../src/db/repositories/agent-sessions.js", () => ({
  getAgentSessionStatus: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../../src/db/repositories/tasks.js", () => ({
  getTask: vi.fn(),
  updateStatus: vi.fn(() => Promise.resolve()),
  assignTask: vi.fn(() => Promise.resolve()),
  addTaskLink: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../src/db/repositories/members.js", () => ({ getWorkspaceMember: vi.fn() }));
vi.mock("../../src/db/repositories/memories.js", () => ({ upsertMemory: vi.fn() }));
vi.mock("../../src/observability/metrics.js", () => ({
  recordAutonomyAction: vi.fn(),
  recordAutonomyTick: vi.fn(),
}));

const { AutonomyEngine } = await import("../../src/autonomy/engine.js");

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};
const poster = { post: vi.fn(() => Promise.resolve({ id: "msg_1" })) };

beforeEach(() => vi.clearAllMocks());

describe("AutonomyEngine maintenance pause (#99)", () => {
  it("skips the entire pass without listing workspaces when maintenance is active", async () => {
    const engine = new AutonomyEngine({
      poster,
      logger: silentLogger,
      maintenancePaused: () => Promise.resolve(true),
    });

    await engine.tickAll();

    expect(listActiveWorkflowWorkspaces).not.toHaveBeenCalled();
  });

  it("runs normally (lists workspaces) when maintenance is inactive", async () => {
    const engine = new AutonomyEngine({
      poster,
      logger: silentLogger,
      maintenancePaused: () => Promise.resolve(false),
    });

    await engine.tickAll();

    expect(listActiveWorkflowWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("runs normally when no maintenance check is wired (unchanged default behaviour)", async () => {
    const engine = new AutonomyEngine({ poster, logger: silentLogger });

    await engine.tickAll();

    expect(listActiveWorkflowWorkspaces).toHaveBeenCalledTimes(1);
  });
});
