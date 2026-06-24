import { describe, it, expect, vi } from "vitest";
import { SlackEventService, type SlackServiceDeps } from "../../src/slack/service.js";
import type { ApprovalRequest, DecisionOutcome } from "../../src/db/repositories/approvals.js";
import type { SlackClient } from "../../src/slack/client.js";

/**
 * SlackEventService (#170) — the bridge logic, fully fake-driven (no DB, no network). Proves: an
 * app_mention is posted into the linked channel AS the acting member (so the EXISTING trigger launches
 * the session) and the thread is recorded; retries dedupe; an agent reply mirrors back into the Slack
 * thread; and the Approve/Reject round-trip enforces the #13 guards (humans only, not your own request).
 */

class RecordingClient implements SlackClient {
  posts: Array<{ token: string; input: unknown }> = [];
  dms: string[] = [];
  async postMessage(token: string, input: unknown): Promise<{ ts: string } | null> {
    this.posts.push({ token, input });
    return { ts: "111.222" };
  }
  async openDm(_token: string, userId: string): Promise<{ channel: string } | null> {
    this.dms.push(userId);
    return { channel: `D-${userId}` };
  }
}

const SECRETS = { botToken: "xoxb-tok", signingSecret: "sek", botUserId: "U0BOT", teamId: "T1" };

function baseDeps(over: Partial<SlackServiceDeps> = {}): { deps: SlackServiceDeps; client: RecordingClient } {
  const client = new RecordingClient();
  const deps: SlackServiceDeps = {
    getSecrets: async () => SECRETS,
    client,
    resolveChannelLink: async () => "chan-1",
    resolveMember: async () => "member-human",
    resolveOwner: async () => "member-owner",
    resolveSlackUser: async () => "U-OWNER",
    postHumanMessage: vi.fn(async () => ({ messageId: "msg-root" })),
    linkThread: vi.fn(async () => {}),
    getThreadForRoot: async () => null,
    markEventSeen: async () => true,
    getRequest: async () => undefined,
    approve: async () => ({ outcome: "conflict" }) as DecisionOutcome,
    reject: async () => ({ outcome: "conflict" }) as DecisionOutcome,
    executeApproved: vi.fn(async (r: ApprovalRequest) => r),
    memberIsHuman: async () => true,
    canClear: async () => true,
    digestInput: async () => ({
      brandName: "ipop",
      sessionsLaunched: 0,
      tasksCompleted: 0,
      pendingApprovals: [],
      spendCents: 0,
    }),
    log: { error: () => {}, info: () => {}, warn: () => {} } as unknown as SlackServiceDeps["log"],
    ...over,
  };
  return { deps, client };
}

function mention(over: Record<string, unknown> = {}) {
  return {
    event_id: "Ev1",
    event: { type: "app_mention", channel: "C1", user: "U-AUTHOR", text: "<@U0BOT> scout audit acme.com", ts: "9.9", ...over },
  };
}

describe("SlackEventService.handleEvent (#170 — mention → existing path)", () => {
  it("posts the translated mention as the acting member and records the thread", async () => {
    const { deps } = baseDeps();
    const svc = new SlackEventService(deps);
    const res = await svc.handleEvent("ws-1", mention());
    expect(res.status).toBe("launched");
    expect(deps.postHumanMessage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      channelId: "chan-1",
      memberId: "member-human",
      body: "@scout audit acme.com",
    });
    expect(deps.linkThread).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      rootMessageId: "msg-root",
      slackChannelId: "C1",
      slackThreadTs: "9.9",
    });
  });

  it("falls back to the workspace owner when the Slack user is unlinked", async () => {
    const { deps } = baseDeps({ resolveMember: async () => null });
    await new SlackEventService(deps).handleEvent("ws-1", mention());
    expect(deps.postHumanMessage).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-owner" }),
    );
  });

  it("dedupes a retried event id (no second post)", async () => {
    const { deps } = baseDeps({ markEventSeen: async () => false });
    const res = await new SlackEventService(deps).handleEvent("ws-1", mention());
    expect(res.status).toBe("duplicate");
    expect(deps.postHumanMessage).not.toHaveBeenCalled();
  });

  it("ignores a Slack channel with no platform link", async () => {
    const { deps } = baseDeps({ resolveChannelLink: async () => null });
    const res = await new SlackEventService(deps).handleEvent("ws-1", mention());
    expect(res.status).toBe("ignored");
    expect(deps.postHumanMessage).not.toHaveBeenCalled();
  });
});

describe("SlackEventService.handleAgentPost (#170 — reply mirror)", () => {
  it("mirrors an agent reply into the recorded Slack thread", async () => {
    const { deps, client } = baseDeps({
      getThreadForRoot: async () => ({ slackChannelId: "C1", slackThreadTs: "9.9" }),
    });
    await new SlackEventService(deps).handleAgentPost({
      workspaceId: "ws-1",
      channelId: "chan-1",
      messageId: "reply-1",
      parentMessageId: "msg-root",
      body: "done — acme.com audited",
    });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]!.input).toMatchObject({
      channel: "C1",
      threadTs: "9.9",
      text: "done — acme.com audited",
    });
  });

  it("is a no-op for a post with no Slack thread (no echo loop)", async () => {
    const { deps, client } = baseDeps({ getThreadForRoot: async () => null });
    await new SlackEventService(deps).handleAgentPost({
      workspaceId: "ws-1",
      channelId: "chan-1",
      messageId: "reply-1",
      parentMessageId: "msg-root",
      body: "hi",
    });
    expect(client.posts).toHaveLength(0);
  });
});

describe("SlackEventService.handleInteractivity (#170 — #13 round-trip, guards intact)", () => {
  const request: ApprovalRequest = {
    id: "req-1",
    workspaceId: "ws-1",
    requesterMemberId: "agent-x",
    actionType: "external.send",
    payload: {},
    amount: null,
    summary: "Post a tweet",
    status: "pending",
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: null,
    expiresAtTimezone: "UTC",
    result: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const value = JSON.stringify({ rid: "req-1", wid: "ws-1" });

  it("approves through the same decision path and executes", async () => {
    const approve = vi.fn(async () => ({ outcome: "approved", request }) as DecisionOutcome);
    const { deps } = baseDeps({
      getRequest: async () => request,
      resolveMember: async () => "member-decider",
      approve,
    });
    const svc = new SlackEventService(deps);
    const res = await svc.handleInteractivity("ws-1", {
      user: { id: "U-DECIDER" },
      actions: [{ action_id: "ipop_approve", value }],
    });
    expect(approve).toHaveBeenCalledWith("req-1", "ws-1", "member-decider", "via Slack");
    expect(deps.executeApproved).toHaveBeenCalled();
    expect(res.ack).toMatch(/Approved/);
  });

  it("blocks a member approving their OWN request (#13 guard)", async () => {
    const approve = vi.fn();
    const { deps } = baseDeps({
      getRequest: async () => ({ ...request, requesterMemberId: "member-decider" }),
      resolveMember: async () => "member-decider",
      approve: approve as never,
    });
    const res = await new SlackEventService(deps).handleInteractivity("ws-1", {
      user: { id: "U-DECIDER" },
      actions: [{ action_id: "ipop_approve", value }],
    });
    expect(approve).not.toHaveBeenCalled();
    expect(res.ack).toMatch(/can't|different human/i);
  });

  it("blocks an agent (non-human) decider (#13 humans-only)", async () => {
    const approve = vi.fn();
    const { deps } = baseDeps({
      getRequest: async () => request,
      resolveMember: async () => "agent-y",
      memberIsHuman: async () => false,
      approve: approve as never,
    });
    const res = await new SlackEventService(deps).handleInteractivity("ws-1", {
      user: { id: "U-AGENT" },
      actions: [{ action_id: "ipop_approve", value }],
    });
    expect(approve).not.toHaveBeenCalled();
    expect(res.ack).toMatch(/can't|different human/i);
  });

  it("ignores a cross-tenant action value (wid mismatch)", async () => {
    const approve = vi.fn();
    const { deps } = baseDeps({ approve: approve as never });
    await new SlackEventService(deps).handleInteractivity("ws-OTHER", {
      user: { id: "U-DECIDER" },
      actions: [{ action_id: "ipop_approve", value }],
    });
    expect(approve).not.toHaveBeenCalled();
  });
});
