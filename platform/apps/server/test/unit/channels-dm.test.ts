import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrCreateDm = vi.fn(async () => ({ id: "dm-1", workspaceId: "ws-1", kind: "dm", name: null }));

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: "ws-1", memberId: "member-self" })),
  assertWorkspace: vi.fn(() => true),
}));

vi.mock("../../src/auth/access.js", () => ({
  requireChannelCapability: vi.fn(),
}));

vi.mock("../../src/db/repositories/channels.js", () => ({
  createChannel: vi.fn(),
  getChannel: vi.fn(),
  listChannels: vi.fn(),
  archiveChannel: vi.fn(),
  addChannelMember: vi.fn(),
  removeChannelMember: vi.fn(),
  isChannelMember: vi.fn(),
  getOrCreateDm,
}));

vi.mock("../../src/db/repositories/permissions.js", () => ({
  grantCapability: vi.fn(),
  revokeCapability: vi.fn(),
  listResourceGrants: vi.fn(),
}));

vi.mock("../../src/db/repositories/members.js", () => ({
  memberInWorkspace: vi.fn(),
}));

vi.mock("../../src/db/repositories/messages.js", () => ({
  postMessage: vi.fn(),
  listChannelMessages: vi.fn(),
  listThreadReplies: vi.fn(),
  countReplies: vi.fn(),
}));

vi.mock("../../src/messaging/threads.js", () => ({
  resolveThreadRoot: vi.fn(),
}));

vi.mock("../../src/messaging/delivery.js", () => ({
  deliverPostedMessage: vi.fn(),
  deliverThreadReply: vi.fn(),
}));

const { MAX_DM_MEMBER_IDS, channelRoutes } = await import("../../src/routes/channels.js");

async function appWithRoutes() {
  const app = Fastify();
  await app.register(channelRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DM route member bounds", () => {
  it("rejects over-limit memberIds before repository lookup", async () => {
    const app = await appWithRoutes();

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws-1/dms",
      payload: { memberIds: Array.from({ length: MAX_DM_MEMBER_IDS + 1 }, (_, i) => "member-" + i) },
    });

    expect(res.statusCode).toBe(400);
    expect(getOrCreateDm).not.toHaveBeenCalled();
    await app.close();
  });

  it("deduplicates a boundary-sized memberIds array and includes the caller", async () => {
    const app = await appWithRoutes();
    const memberIds = Array.from({ length: MAX_DM_MEMBER_IDS }, (_, i) => "member-" + i);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws-1/dms",
      payload: { memberIds: [memberIds[0], ...memberIds.slice(0, MAX_DM_MEMBER_IDS - 1)] },
    });

    expect(res.statusCode).toBe(200);
    expect(getOrCreateDm).toHaveBeenCalledWith("ws-1", ["member-self", ...memberIds.slice(0, MAX_DM_MEMBER_IDS - 1)]);
    await app.close();
  });
});
