import { describe, it, expect, vi } from "vitest";
import {
  AgentRegistryService,
  type AgentRegistryDeps,
  type DispatchResult,
} from "../../src/agent-registry/service.js";
import { AGENT_REGISTRY_DEFAULTS, type AgentRegistryCaps } from "../../src/agent-registry/caps.js";
import type { A2ACallRecord } from "../../src/agent-registry/types.js";

const ALL = ["scout", "echo", "quill", "postmark", "bid", "lens", "mark", "comet"];
const OWNER = { workspaceId: "ws-owner", memberId: "m-owner" };

function caps(over: Partial<AgentRegistryCaps> = {}): AgentRegistryCaps {
  return { ...AGENT_REGISTRY_DEFAULTS, enabled: true, ownerWorkspaceId: "ws-owner", ...over };
}

function okDispatch(): DispatchResult {
  return { ok: true, channelId: "c-1", messageId: "msg-1", sessionId: "sess-1" };
}

function makeService(over: Partial<AgentRegistryDeps> = {}) {
  const observed: A2ACallRecord[] = [];
  const dispatch = vi.fn(async (): Promise<DispatchResult> => okDispatch());
  const deps: AgentRegistryDeps = {
    caps: () => caps(),
    listPresentHandles: async () => [...ALL],
    dispatch,
    observe: (r) => {
      observed.push(r);
    },
    ...over,
  };
  return { service: new AgentRegistryService(deps), dispatch, observed };
}

describe("agent-registry/service — listAgents (read-only catalog)", () => {
  it("lists every contract with present/enabled flags and reports the workspace enabled state", async () => {
    const { service } = makeService();
    const result = await service.listAgents(OWNER);
    expect(result.entries).toHaveLength(ALL.length);
    expect(result.enabled).toBe(true);
    expect(result.entries.every((e) => e.enabled)).toBe(true);
  });

  it("lists the catalog even when the flag is OFF (entries disabled)", async () => {
    const { service } = makeService({ caps: () => caps({ enabled: false }) });
    const result = await service.listAgents(OWNER);
    expect(result.entries).toHaveLength(ALL.length);
    expect(result.enabled).toBe(false);
  });

  it("filters non-fleet personas out of the present set", async () => {
    const { service } = makeService({ listPresentHandles: async () => ["scout", "owner-bot", "lens"] });
    const result = await service.listAgents(OWNER);
    expect(result.entries.find((e) => e.contract.handle === "scout")!.present).toBe(true);
    expect(result.entries.find((e) => e.contract.handle === "echo")!.present).toBe(false);
  });
});

describe("agent-registry/service — call (governed + observable A2A)", () => {
  it("dispatches an allowed call down the launch seam and returns the observable record", async () => {
    const { service, dispatch, observed } = makeService();
    const result = await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      capability: "content.draft_article",
      task: "Draft a launch post",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.record.status).toBe("allowed");
    expect(result.dispatch).toEqual(okDispatch());
    expect(dispatch).toHaveBeenCalledWith(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      task: "Draft a launch post",
      // #417: dispatch now receives the chain incl. the new target (empty caller chain → just [target]).
      callChain: ["quill"],
    });
    // the hop was recorded for observability
    expect(observed).toHaveLength(1);
    expect(observed[0]!.targetHandle).toBe("quill");
  });

  it("normalizes a @-prefixed, mixed-case handle before deciding", async () => {
    const { service, dispatch } = makeService();
    const result = await service.call(OWNER, {
      callerHandle: "@Scout",
      targetHandle: "@QUILL",
      capability: "content.draft_article",
      task: "hi",
    });
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ callerHandle: "scout", targetHandle: "quill" }),
    );
  });

  it("returns 409 and never dispatches when the feature is disabled", async () => {
    const { service, dispatch } = makeService({ caps: () => caps({ enabled: false }) });
    const result = await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      capability: "content.draft_article",
      task: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 409 in a non-owner workspace while owner-first is on", async () => {
    const { service, dispatch } = makeService({ caps: () => caps({ ownerWorkspaceId: "ws-someone-else" }) });
    const result = await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      capability: "content.draft_article",
      task: "x",
    });
    // flag is on but this workspace isn't the owner ⇒ the target is disabled ⇒ denied (403), not dispatched
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 403 with the decision record (and does not dispatch) on a denied call", async () => {
    const { service, dispatch } = makeService();
    const result = await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "lens",
      capability: "ads.plan_budget", // lens does not advertise this
      task: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(403);
    expect(result.decision?.record.status).toBe("denied");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("propagates a launch denial (kill switch / budget) from the dispatch seam", async () => {
    const { service } = makeService({
      dispatch: async () => ({ ok: false, code: 429, error: "concurrency cap reached" }),
    });
    const result = await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      capability: "content.draft_article",
      task: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(429);
    expect(result.decision?.record.status).toBe("allowed"); // decision allowed, but the launch was denied
  });

  it("records the denied hop too (a refused call is never invisible)", async () => {
    const { service, observed } = makeService();
    await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "lens",
      capability: "ads.plan_budget",
      task: "x",
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]!.status).toBe("denied");
  });

  it("passes the appended chain (incl. the new target) to dispatch", async () => {
    const { service, dispatch } = makeService();
    await service.call(OWNER, {
      callerHandle: "scout",
      targetHandle: "quill",
      capability: "content.draft_article",
      task: "draft it",
      callChain: ["scout"],
    });
    expect(dispatch).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        callerHandle: "scout",
        targetHandle: "quill",
        callChain: ["scout", "quill"],
      }),
    );
  });
});

describe("agent-registry/service — handoffsFromDeliverable (#417)", () => {
  it("launches one teammate @mentioned in a deliverable, with its primary capability + appended chain", async () => {
    const { service, dispatch, observed } = makeService();
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "scout",
      deliverable: "Audit done. @quill please draft the launch post.",
      callChain: ["scout"],
    });
    expect(result.enabled).toBe(true);
    expect(result.mentions).toEqual(["quill"]);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.allowed).toBe(true);
    expect(result.attempts[0]!.dispatched).toBe(true);
    expect(result.attempts[0]!.target).toBe("quill");
    // quill's PRIMARY capability is the first in its contract.
    expect(result.attempts[0]!.capability).toBe("content.draft_article");
    // dispatch saw the appended chain so the NEXT hop is depth/cycle-aware.
    expect(dispatch).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ targetHandle: "quill", callChain: ["scout", "quill"] }),
    );
    expect(observed.map((r) => r.targetHandle)).toEqual(["quill"]);
  });

  it("ignores a self-mention (an agent never hands off to itself)", async () => {
    const { service, dispatch } = makeService();
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "scout",
      deliverable: "Note to self: @scout keep going.",
      callChain: ["scout"],
    });
    expect(result.mentions).toEqual([]);
    expect(result.attempts).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("skips a target already on the call chain (loop-safe)", async () => {
    const { service, dispatch } = makeService();
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "quill",
      deliverable: "@scout your turn again.",
      callChain: ["scout", "quill"],
    });
    expect(result.mentions).toEqual([]);
    expect(result.attempts).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("is disabled (no attempts) when the feature is off (default-OFF, byte-for-byte unchanged)", async () => {
    const { service, dispatch } = makeService({ caps: () => caps({ enabled: false }) });
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "scout",
      deliverable: "@quill draft this",
      callChain: ["scout"],
    });
    expect(result.enabled).toBe(false);
    expect(result.attempts).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("launches multiple distinct teammates in first-seen order", async () => {
    const { service } = makeService();
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "scout",
      deliverable: "@quill draft it then @echo amplify it.",
      callChain: ["scout"],
    });
    expect(result.attempts.map((a) => a.target)).toEqual(["quill", "echo"]);
    expect(result.attempts.every((a) => a.allowed && a.dispatched)).toBe(true);
  });

  it("reports a denied hop (observable) when a hop is denied, without throwing", async () => {
    // A deep chain (depth >= cap) makes the hop deny — but it's still reported, never invisible.
    const { service } = makeService();
    const result = await service.handoffsFromDeliverable(OWNER, {
      callerHandle: "comet",
      deliverable: "@quill take it from here",
      callChain: ["scout", "echo", "comet"], // depth 3 >= default cap
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.allowed).toBe(false);
    expect(result.attempts[0]!.dispatched).toBe(false);
    expect(result.attempts[0]!.reason).toMatch(/depth/i);
  });
});
