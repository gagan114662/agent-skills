import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePlan } from "../../src/billing/plan-service.js";

const requireIdentity = vi.fn();
const assertWorkspace = vi.fn();
const createChannel = vi.fn();

vi.mock("../../src/auth/guard.js", () => ({ requireIdentity, assertWorkspace }));
vi.mock("../../src/auth/access.js", () => ({ requireChannelCapability: vi.fn() }));
vi.mock("../../src/db/repositories/channels.js", () => ({
  createChannel,
  getChannel: vi.fn(),
  listChannels: vi.fn(),
  archiveChannel: vi.fn(),
  addChannelMember: vi.fn(),
  removeChannelMember: vi.fn(),
  isChannelMember: vi.fn(),
  getOrCreateDm: vi.fn(),
}));
vi.mock("../../src/db/repositories/permissions.js", () => ({
  grantCapability: vi.fn(),
  revokeCapability: vi.fn(),
  listResourceGrants: vi.fn(),
}));
vi.mock("../../src/db/repositories/members.js", () => ({ memberInWorkspace: vi.fn() }));
vi.mock("../../src/db/repositories/messages.js", () => ({
  postMessage: vi.fn(),
  listChannelMessages: vi.fn(),
  listThreadReplies: vi.fn(),
  countReplies: vi.fn(),
}));
vi.mock("../../src/messaging/threads.js", () => ({ resolveThreadRoot: vi.fn() }));
vi.mock("../../src/messaging/delivery.js", () => ({ deliverPostedMessage: vi.fn(), deliverThreadReply: vi.fn() }));

const { channelRoutes } = await import("../../src/routes/channels.js");

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
  requireIdentity.mockResolvedValue({ kind: "human", workspaceId: "w1", memberId: "m1" });
  assertWorkspace.mockReturnValue(true);
  createChannel.mockResolvedValue({ id: "c1", workspaceId: "w1", kind: "public", name: "extra", isArchived: false });
});

describe("channelRoutes plan entitlements (#877)", () => {
  it("returns 403 before creating the N+1st public channel beyond the active plan cap", async () => {
    const app = Fastify();
    await app.register(channelRoutes, {
      planQuota: {
        activePlans: { getActive: async () => activePlan },
        countAgents: async () => 0,
        countChannels: async () => 1,
        now: () => new Date("2026-06-25T12:00:00Z"),
      },
    });
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces/w1/channels",
        payload: { name: "extra" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ resource: "channel", limit: 1, used: 1, planKey: "starter" });
      expect(createChannel).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
