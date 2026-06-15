import { describe, it, expect, vi } from "vitest";
import {
  MarketingMentionService,
  type MarketingMentionDeps,
  type MarketingModelGate,
} from "../../../src/marketing/mention.js";

/**
 * #246 — model preflight gate on the @mention path. When the deployment harness needs model auth and
 * the workspace's effective fleet model isn't servable (the `claude-fable-5` class), the persona posts
 * an actionable "pick a valid model" prompt instead of launching a session that would 403 + crash
 * mid-run — NO session, NO admission slot. A valid model launches unchanged.
 */
const identity = { workspaceId: "ws-1", memberId: "human-1" };

function deps(over: Partial<MarketingMentionDeps> = {}): {
  deps: MarketingMentionDeps;
  invoke: ReturnType<typeof vi.fn>;
  postModelPrompt: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => ({ ok: true as const, sessionId: "sess-1" }));
  const recordTask = vi.fn(async () => ({ id: "mt-1" }));
  const postModelPrompt = vi.fn(async () => ({ id: "msg-model" }));
  const base: MarketingMentionDeps = {
    getChannel: async (id) => ({ id, workspaceId: "ws-1", name: "seo" }),
    isMarketingChannel: (name) => name === "seo",
    personaMentions: async () => [{ id: "p-scout", agentMemberId: "am-scout", name: "scout" }],
    invoke,
    recordTask,
    departmentForHandle: (h) => (h === "scout" ? "seo" : undefined),
    ...over,
  };
  return { deps: base, invoke, postModelPrompt };
}

function modelGate(
  over: Partial<MarketingModelGate>,
  postModelPrompt: MarketingModelGate["postModelPrompt"],
): MarketingModelGate {
  return {
    required: true,
    check: async () => ({ ok: false, model: "claude-fable-5" }),
    postModelPrompt,
    ...over,
  };
}

describe("#246 mention model gate", () => {
  it("posts a 'pick a valid model' prompt (no launch) when the model is unservable", async () => {
    const { deps: d, invoke, postModelPrompt } = deps();
    d.model = modelGate({ check: async () => ({ ok: false, model: "claude-fable-5" }) }, postModelPrompt);

    const res = await new MarketingMentionService(d).launch(identity, {
      channelId: "c-seo",
      messageId: "m-1",
      task: "audit homepage",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toEqual([]);
    expect(res.modelBlocked).toEqual([
      { personaId: "p-scout", handle: "scout", department: "seo", model: "claude-fable-5", messageId: "msg-model" },
    ]);
    expect(invoke).not.toHaveBeenCalled();
    expect(postModelPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", agentMemberId: "am-scout", model: "claude-fable-5", parentMessageId: "m-1" }),
    );
  });

  it("launches normally when the model is valid", async () => {
    const { deps: d, invoke, postModelPrompt } = deps();
    d.model = modelGate({ check: async () => ({ ok: true }) }, postModelPrompt);

    const res = await new MarketingMentionService(d).launch(identity, { channelId: "c-seo", messageId: "m-1" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toHaveLength(1);
    expect(res.modelBlocked).toEqual([]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(postModelPrompt).not.toHaveBeenCalled();
  });

  it("does not gate when the harness needs no model auth (required:false)", async () => {
    const { deps: d, invoke, postModelPrompt } = deps();
    const check = vi.fn(async () => ({ ok: false as const, model: "claude-fable-5" }));
    d.model = modelGate({ required: false, check }, postModelPrompt);

    const res = await new MarketingMentionService(d).launch(identity, { channelId: "c-seo", messageId: "m-1" });

    expect(res.ok).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
    expect(postModelPrompt).not.toHaveBeenCalled();
  });
});
