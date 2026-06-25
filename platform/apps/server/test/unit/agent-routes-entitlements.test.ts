import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePlan } from "../../src/billing/plan-service.js";

const resolveIdentity = vi.fn();
const createAgentWithToken = vi.fn();
const listAgents = vi.fn();
const generateAgentToken = vi.fn();

vi.mock("../../src/auth/middleware.js", () => ({ resolveIdentity }));
vi.mock("../../src/auth/secrets.js", () => ({ generateAgentToken }));
vi.mock("../../src/db/repositories/auth.js", () => ({
  createAgentWithToken,
  revokeAgentToken: vi.fn(),
  listAgents,
  deactivateAgent: vi.fn(),
}));

const { agentRoutes } = await import("../../src/routes/agents.js");

const activePlan: ActivePlan = {
  workspaceId: "w1",
  planKey: "starter",
  status: "active",
  renewalStatus: "active",
  agentSeats: 3,
  monthlySessionBudgetCents: 20_000,
  fleetSize: 1,
  providerEventId: null,
  expiresAt: new Date("2026-07-25T00:00:00Z"),
  nextBillingAt: new Date("2026-07-25T00:00:00Z"),
  retryCount: 0,
  retryScheduledAt: null,
  lastPaymentFailedAt: null,
  activatedAt: new Date("2026-06-25T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveIdentity.mockResolvedValue({ kind: "human", workspaceId: "w1", memberId: "m1" });
  generateAgentToken.mockReturnValue({ raw: "raw-token", hash: "token-hash" });
  createAgentWithToken.mockResolvedValue({ agentId: "a1", memberId: "am1", tokenId: "t1" });
  listAgents.mockResolvedValue([]);
});

describe("agentRoutes plan entitlements (#877)", () => {
  it("returns 403 before creating the N+1st agent beyond the active plan cap", async () => {
    const app = Fastify();
    await app.register(agentRoutes, {
      planQuota: {
        activePlans: { getActive: async () => activePlan },
        countAgents: async () => 3,
        countChannels: async () => 0,
        now: () => new Date("2026-06-25T12:00:00Z"),
      },
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/w1/agents",
        payload: { name: "extra-agent" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ resource: "agent", limit: 3, used: 3, planKey: "starter" });
      expect(createAgentWithToken).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
