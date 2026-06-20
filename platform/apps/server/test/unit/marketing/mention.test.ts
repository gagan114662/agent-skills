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

  it("#417 threads systemAuthorized through to the invoke gate (governed a2a handoff)", async () => {
    const { deps, invoke } = baseDeps();
    const svc = new MarketingMentionService(deps);
    await svc.launch(identity, {
      channelId: "c-seo",
      messageId: "m-1",
      task: "draft it",
      systemAuthorized: true,
    });
    expect(invoke).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ personaId: "p-scout", systemAuthorized: true }),
    );
  });

  it("#417 omits systemAuthorized by default (human @mention unchanged)", async () => {
    const { deps, invoke } = baseDeps();
    const svc = new MarketingMentionService(deps);
    await svc.launch(identity, { channelId: "c-seo", messageId: "m-1", task: "audit homepage" });
    expect(invoke).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ systemAuthorized: undefined }),
    );
  });

  it("#320 enriches the LAUNCHED task via enrichTask but records the ORIGINAL goal", async () => {
    const enrichTask = vi.fn(async (_ws: string, task: string) => `CONTEXT\n\nTask: ${task}`);
    const { deps, recordTask, invoke } = baseDeps({ enrichTask });
    const svc = new MarketingMentionService(deps);

    const res = await svc.launch(identity, { channelId: "c-seo", messageId: "m-1", task: "audit homepage" });

    expect(res.ok).toBe(true);
    expect(enrichTask).toHaveBeenCalledWith("ws-1", "audit homepage");
    // the agent receives the enriched task (with the workspace-context preamble) ...
    expect(invoke).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ task: "CONTEXT\n\nTask: audit homepage" }),
    );
    // ... but the durable board record keeps the clean human goal.
    expect(recordTask).toHaveBeenCalledWith(expect.objectContaining({ task: "audit homepage" }));
  });

  it("#320 with no enrichTask dep the launched task is the raw goal (default posture unchanged)", async () => {
    const { deps, invoke } = baseDeps();
    await new MarketingMentionService(deps).launch(identity, { channelId: "c-seo", messageId: "m-1", task: "go" });
    expect(invoke).toHaveBeenCalledWith(identity, expect.objectContaining({ task: "go" }));
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

  it("#322 dedup: briefing the SAME objective twice does not create a second task or session", async () => {
    // A shared store the dedup gate reads, that grows as launches record tasks — exactly the production
    // wiring (the dedup gate reads `listMarketingTasks` filtered to open). The objective is identical.
    const objective = "Audit our website's homepage for SEO and summarise the top quick wins";
    const open: Array<{ id: string; department: string; task: string }> = [];
    let n = 0;
    const recordTask = vi.fn(async (input: { department: string; task: string }) => {
      const id = `mt-${++n}`;
      open.push({ id, department: input.department, task: input.task });
      return { id };
    });
    const invoke = vi.fn(async () => ({ ok: true as const, sessionId: `sess-${n + 1}` }));
    const { deps } = baseDeps({
      recordTask: recordTask as never,
      invoke,
      dedupe: {
        isEnabled: async () => true,
        openTasks: async () => open.map((t) => ({ ...t })),
      },
    });
    const svc = new MarketingMentionService(deps);

    // First brief: opens the task and launches.
    const first = await svc.launch(identity, { channelId: "c-seo", messageId: "m-1", task: objective });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");
    expect(first.launched).toHaveLength(1);
    expect(first.deduped).toHaveLength(0);

    // Second brief of the SAME objective: deduped — NO second invoke, NO second task recorded.
    const second = await svc.launch(identity, { channelId: "c-seo", messageId: "m-2", task: objective });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");
    expect(second.launched).toHaveLength(0);
    expect(second.deduped).toEqual([
      { personaId: "p-scout", handle: "scout", department: "seo", existingTaskId: "mt-1" },
    ]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(recordTask).toHaveBeenCalledTimes(1);
    expect(open).toHaveLength(1);
  });

  it("#322 dedup: a DIFFERENT objective in the same department still launches (no false collapse)", async () => {
    const open: Array<{ id: string; department: string; task: string }> = [
      { id: "mt-1", department: "seo", task: "Audit our homepage for SEO" },
    ];
    const { deps, invoke, recordTask } = baseDeps({
      dedupe: { isEnabled: async () => true, openTasks: async () => open },
    });
    const res = await new MarketingMentionService(deps).launch(identity, {
      channelId: "c-seo",
      messageId: "m-2",
      task: "Build us a backlink outreach plan",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toHaveLength(1);
    expect(res.deduped).toHaveLength(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(recordTask).toHaveBeenCalledTimes(1);
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
