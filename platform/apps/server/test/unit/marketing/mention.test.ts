import { describe, it, expect, vi } from "vitest";
import {
  MarketingMentionService,
  type MarketingMentionDeps,
} from "../../../src/marketing/mention.js";

/**
 * #123 @mention → real session. The trigger reuses the audited #59 SubagentService gate (injected here
 * as `invoke`) whose launcher is the venture-gated SessionManager, then records a durable task. These
 * tests pin the gating (marketing-channel only, must mention an agent), the task record, and that a
 * launch denial (kill switch / budget — `invoke` throws AdmissionError) propagates with NO task written.
 */
const identity = { workspaceId: "ws-1", memberId: "human-1" };

function baseDeps(over: Partial<MarketingMentionDeps> = {}): {
  deps: MarketingMentionDeps;
  recordTask: ReturnType<typeof vi.fn>;
  invoke: ReturnType<typeof vi.fn>;
} {
  const recordTask = vi.fn(async () => ({ id: "mt-1" }));
  const invoke = vi.fn(async () => ({ ok: true as const, sessionId: "sess-1" }));
  const deps: MarketingMentionDeps = {
    getChannel: async (id) => ({ id, workspaceId: "ws-1", name: "seo" }),
    isMarketingChannel: (name) => name === "seo" || name === "social",
    personaMentions: async () => [{ id: "p-scout", agentMemberId: "am-scout", name: "scout" }],
    invoke,
    recordTask,
    departmentForHandle: (h) => (h === "scout" ? "seo" : undefined),
    ...over,
  };
  return { deps, recordTask, invoke };
}

describe("#123 MarketingMentionService", () => {
  it("launches a session per mentioned agent and records a mention task", async () => {
    const { deps, recordTask, invoke } = baseDeps();
    const svc = new MarketingMentionService(deps);

    const res = await svc.launch(identity, { channelId: "c-seo", messageId: "m-1", task: "audit homepage" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toEqual([
      { personaId: "p-scout", handle: "scout", department: "seo", sessionId: "sess-1", taskId: "mt-1" },
    ]);
    expect(invoke).toHaveBeenCalledWith(identity, {
      personaId: "p-scout",
      channelId: "c-seo",
      task: "audit homepage",
      messageId: "m-1",
    });
    expect(recordTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mention", department: "seo", agentMemberId: "am-scout", sessionId: "sess-1" }),
    );
  });

  it("404s a channel from another workspace (IDOR)", async () => {
    const { deps, invoke } = baseDeps({ getChannel: async (id) => ({ id, workspaceId: "other", name: "seo" }) });
    const res = await new MarketingMentionService(deps).launch(identity, { channelId: "c", messageId: "m" });
    expect(res).toMatchObject({ ok: false, code: 404 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("400s outside a marketing channel", async () => {
    const { deps, invoke } = baseDeps({ getChannel: async (id) => ({ id, workspaceId: "ws-1", name: "random" }) });
    const res = await new MarketingMentionService(deps).launch(identity, { channelId: "c", messageId: "m" });
    expect(res).toMatchObject({ ok: false, code: 400 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("400s when no marketing agent is mentioned", async () => {
    const { deps } = baseDeps({ personaMentions: async () => [] });
    const res = await new MarketingMentionService(deps).launch(identity, { channelId: "c", messageId: "m" });
    expect(res).toMatchObject({ ok: false, code: 400 });
  });

  it("propagates the SubagentService gate result (e.g. 403) without recording a task", async () => {
    const recordTask = vi.fn();
    const { deps } = baseDeps({
      invoke: async () => ({ ok: false as const, code: 403, error: "not permitted" }),
      recordTask: recordTask as never,
    });
    const res = await new MarketingMentionService(deps).launch(identity, { channelId: "c", messageId: "m" });
    expect(res).toMatchObject({ ok: false, code: 403 });
    expect(recordTask).not.toHaveBeenCalled();
  });

  it("lets a launch denial (kill switch / budget) propagate and records no task", async () => {
    const recordTask = vi.fn();
    const { deps } = baseDeps({
      invoke: async () => {
        throw new Error("launch denied: budget_exceeded");
      },
      recordTask: recordTask as never,
    });
    await expect(
      new MarketingMentionService(deps).launch(identity, { channelId: "c", messageId: "m" }),
    ).rejects.toThrow(/budget_exceeded/);
    expect(recordTask).not.toHaveBeenCalled();
  });
});
