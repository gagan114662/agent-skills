import { describe, it, expect, vi } from "vitest";
import { buildA2ADispatch, type A2ADispatchBrief } from "../../src/agent-registry/default.js";
import type { MarketingBriefResult } from "../../src/marketing/brief.js";

/**
 * #417: the A2A dispatch seam launches a governed agent→agent handoff through the #235 brief front door.
 * Because decideA2ACall already authorized the hop (depth/cycle/capability), the dispatch MUST set
 * `systemAuthorized: true` so the brief launches without the human #9 channel-RBAC head — which the caller
 * agent (e.g. scout) can't satisfy on the target's channel. These tests pin that the flag is set and the
 * structural handoff goal (attribution + chain marker) is preserved.
 */
const IDENTITY = { workspaceId: "ws-owner", memberId: "m-owner" };

function okBrief(): MarketingBriefResult {
  return {
    ok: true,
    lead: "quill",
    department: "content",
    channelId: "c-content",
    messageId: "msg-1",
    launched: [{ personaId: "p-quill", handle: "quill", department: "content", sessionId: "sess-1", taskId: "mt-1" }],
    connectPrompted: [],
    modelBlocked: [],
    deduped: [],
  };
}

describe("agent-registry/default — buildA2ADispatch (#417 system-authorized handoff)", () => {
  it("dispatches through the brief with systemAuthorized:true (bypasses the human channel-RBAC head)", async () => {
    const brief = vi.fn(async (): Promise<MarketingBriefResult> => okBrief());
    const dispatch = buildA2ADispatch({ brief } as A2ADispatchBrief);

    const result = await dispatch(IDENTITY, {
      callerHandle: "scout",
      targetHandle: "quill",
      task: "draft the launch post",
      callChain: ["scout", "quill"],
    });

    expect(result).toEqual({ ok: true, channelId: "c-content", messageId: "msg-1", sessionId: "sess-1" });
    expect(brief).toHaveBeenCalledTimes(1);
    const [identityArg, inputArg] = brief.mock.calls[0]!;
    expect(identityArg).toEqual({ workspaceId: "ws-owner", memberId: "m-owner" });
    // THE FIX: the governed a2a handoff is launched system-authorized.
    expect(inputArg.systemAuthorized).toBe(true);
    expect(inputArg.lead).toBe("quill");
    // Attribution prefix + chain marker are preserved on the handoff goal (structural, #200).
    expect(inputArg.goal).toContain("[A2A handoff from @scout] draft the launch post");
  });

  it("propagates a brief failure (kill switch / budget) as a dispatch failure", async () => {
    const brief = vi.fn(
      async (): Promise<MarketingBriefResult> => ({ ok: false, code: 429, error: "concurrency cap reached" }),
    );
    const dispatch = buildA2ADispatch({ brief } as A2ADispatchBrief);
    const result = await dispatch(IDENTITY, {
      callerHandle: "scout",
      targetHandle: "quill",
      task: "x",
      callChain: ["scout", "quill"],
    });
    expect(result).toEqual({ ok: false, code: 429, error: "concurrency cap reached" });
  });

  it("leaves the goal byte-identical to the manual route on an empty chain (no marker)", async () => {
    const brief = vi.fn(async (): Promise<MarketingBriefResult> => okBrief());
    const dispatch = buildA2ADispatch({ brief } as A2ADispatchBrief);
    await dispatch(IDENTITY, {
      callerHandle: "scout",
      targetHandle: "quill",
      task: "draft it",
      callChain: [],
    });
    const [, inputArg] = brief.mock.calls[0]!;
    expect(inputArg.goal).toBe("[A2A handoff from @scout] draft it");
    expect(inputArg.systemAuthorized).toBe(true);
  });
});
