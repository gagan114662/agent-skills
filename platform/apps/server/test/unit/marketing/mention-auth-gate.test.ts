import { describe, it, expect, vi } from "vitest";
import {
  MarketingMentionService,
  type MarketingMentionDeps,
  type MarketingAuthGate,
} from "../../../src/marketing/mention.js";

/**
 * #68 — subscription-first auth gate on the @mention path. When the deployment harness needs model
 * auth and the workspace hasn't connected a Claude account, the persona posts a friendly connect
 * prompt instead of launching — NO session, NO admission slot, NO budget burn. When auth is present
 * (or the harness is the demo harness that needs none), the launch proceeds unchanged.
 */
const identity = { workspaceId: "ws-1", memberId: "human-1" };

function deps(over: Partial<MarketingMentionDeps> = {}): {
  deps: MarketingMentionDeps;
  invoke: ReturnType<typeof vi.fn>;
  recordTask: ReturnType<typeof vi.fn>;
  postConnectPrompt: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => ({ ok: true as const, sessionId: "sess-1" }));
  const recordTask = vi.fn(async () => ({ id: "mt-1" }));
  const postConnectPrompt = vi.fn(async () => ({ id: "msg-connect" }));
  const base: MarketingMentionDeps = {
    getChannel: async (id) => ({ id, workspaceId: "ws-1", name: "seo" }),
    isMarketingChannel: (name) => name === "seo",
    personaMentions: async () => [{ id: "p-scout", agentMemberId: "am-scout", name: "scout" }],
    invoke,
    recordTask,
    departmentForHandle: (h) => (h === "scout" ? "seo" : undefined),
    ...over,
  };
  return { deps: base, invoke, recordTask, postConnectPrompt };
}

function gate(over: Partial<MarketingAuthGate>, postConnectPrompt: MarketingAuthGate["postConnectPrompt"]): MarketingAuthGate {
  return { required: true, hasAuth: async () => false, postConnectPrompt, ...over };
}

describe("#68 mention auth gate", () => {
  it("posts a connect prompt (no launch, no task) when auth is required but missing", async () => {
    const { deps: d, invoke, recordTask, postConnectPrompt } = deps();
    d.auth = gate({ required: true, hasAuth: async () => false }, postConnectPrompt);

    const res = await new MarketingMentionService(d).launch(identity, {
      channelId: "c-seo",
      messageId: "m-1",
      task: "audit homepage",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toEqual([]);
    expect(res.connectPrompted).toEqual([
      { personaId: "p-scout", handle: "scout", department: "seo", messageId: "msg-connect" },
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(recordTask).not.toHaveBeenCalled();
    expect(postConnectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        channelId: "c-seo",
        agentMemberId: "am-scout",
        personaName: "scout",
        parentMessageId: "m-1",
      }),
    );
  });

  it("launches normally when auth is required AND present", async () => {
    const { deps: d, invoke, postConnectPrompt } = deps();
    d.auth = gate({ required: true, hasAuth: async () => true }, postConnectPrompt);

    const res = await new MarketingMentionService(d).launch(identity, { channelId: "c-seo", messageId: "m-1" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toHaveLength(1);
    expect(res.connectPrompted).toEqual([]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(postConnectPrompt).not.toHaveBeenCalled();
  });

  it("does not gate when the harness needs no auth (required:false)", async () => {
    const { deps: d, invoke, postConnectPrompt } = deps();
    const hasAuth = vi.fn(async () => false);
    d.auth = gate({ required: false, hasAuth }, postConnectPrompt);

    const res = await new MarketingMentionService(d).launch(identity, { channelId: "c-seo", messageId: "m-1" });

    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(hasAuth).not.toHaveBeenCalled();
    expect(postConnectPrompt).not.toHaveBeenCalled();
  });

  it("checks auth scoped to the caller's workspace (per-tenant)", async () => {
    const { deps: d, postConnectPrompt } = deps();
    const hasAuth = vi.fn(async () => false);
    d.auth = gate({ required: true, hasAuth }, postConnectPrompt);

    await new MarketingMentionService(d).launch(identity, { channelId: "c-seo", messageId: "m-1" });
    expect(hasAuth).toHaveBeenCalledWith("ws-1");
  });
});
