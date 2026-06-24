import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceMember = vi.fn(async () => ({ id: "agent-1", kind: "agent" }));
const upsertAutonomy = vi.fn(async (input) => ({
  id: "autonomy-1",
  agentMemberId: input.agentMemberId,
  enabled: input.enabled,
  maxActionsPerTick: input.maxActionsPerTick,
  actionBudget: input.actionBudget,
  actionsUsed: 0,
}));

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: "ws-1", memberId: "human-1", kind: "human" })),
  assertWorkspace: vi.fn(() => true),
}));

vi.mock("../../src/auth/access.js", () => ({
  requireChannelCapability: vi.fn(),
  requireTaskInWorkspace: vi.fn(),
}));

vi.mock("../../src/db/repositories/members.js", () => ({
  getWorkspaceMember,
}));

vi.mock("../../src/db/repositories/channels.js", () => ({
  addChannelMember: vi.fn(),
}));

vi.mock("../../src/db/repositories/permissions.js", () => ({
  grantCapability: vi.fn(),
}));

vi.mock("../../src/db/repositories/tasks.js", () => ({
  assignTask: vi.fn(),
}));

vi.mock("../../src/db/repositories/autonomy.js", () => ({
  createPool: vi.fn(),
  listPools: vi.fn(),
  getPool: vi.fn(),
  addPoolMember: vi.fn(),
  listPoolMembers: vi.fn(),
  agentRoles: vi.fn(),
  isAgentPooled: vi.fn(),
  upsertAutonomy,
  getControls: vi.fn(),
  setKillSwitch: vi.fn(),
  createWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  listWorkflowsInChannel: vi.fn(),
  listApprovals: vi.fn(),
}));

const {
  MAX_AUTONOMY_ACTIONS_PER_TICK,
  MAX_AUTONOMY_ACTION_BUDGET,
  autonomyRoutes,
} = await import("../../src/routes/autonomy.js");

async function appWithRoutes() {
  const app = Fastify();
  await app.register(autonomyRoutes, {
    engine: {
      tickWorkspace: vi.fn(),
    } as never,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  getWorkspaceMember.mockResolvedValue({ id: "agent-1", kind: "agent" });
});

describe("autonomy config bounds", () => {
  it.each([
    ["actionBudget", 0],
    ["actionBudget", -1],
    ["actionBudget", 1.5],
    ["actionBudget", MAX_AUTONOMY_ACTION_BUDGET + 1],
    ["maxActionsPerTick", 0],
    ["maxActionsPerTick", -1],
    ["maxActionsPerTick", 1.5],
    ["maxActionsPerTick", MAX_AUTONOMY_ACTIONS_PER_TICK + 1],
  ])("rejects invalid %s=%s before persistence", async (field, value) => {
    const app = await appWithRoutes();

    const res = await app.inject({
      method: "PUT",
      url: "/workspaces/ws-1/agents/agent-1/autonomy",
      payload: { enabled: true, [field]: value },
    });

    expect(res.statusCode).toBe(400);
    expect(upsertAutonomy).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists valid in-range autonomy bounds", async () => {
    const app = await appWithRoutes();

    const res = await app.inject({
      method: "PUT",
      url: "/workspaces/ws-1/agents/agent-1/autonomy",
      payload: {
        enabled: true,
        maxActionsPerTick: MAX_AUTONOMY_ACTIONS_PER_TICK,
        actionBudget: MAX_AUTONOMY_ACTION_BUDGET,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(upsertAutonomy).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      agentMemberId: "agent-1",
      enabled: true,
      maxActionsPerTick: MAX_AUTONOMY_ACTIONS_PER_TICK,
      actionBudget: MAX_AUTONOMY_ACTION_BUDGET,
    });
    await app.close();
  });
});
