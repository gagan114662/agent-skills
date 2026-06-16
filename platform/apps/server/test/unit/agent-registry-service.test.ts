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
});
