import { describe, expect, it, vi } from "vitest";
import { SubagentService } from "../../src/subagents/service.js";
import type { SubagentServiceDeps, SubagentLauncher } from "../../src/subagents/service.js";
import type { AgentPersona } from "../../src/db/repositories/personas.js";
import type { Capability } from "../../src/auth/access.js";

const IDENTITY = { workspaceId: "ws_1", memberId: "mem_human", kind: "human" as const, displayName: "Owner" };

const PERSONA: AgentPersona = {
  id: "per_1",
  workspaceId: "ws_1",
  agentMemberId: "mem_reviewer",
  agentId: "agt_1",
  name: "code-reviewer",
  systemPrompt: "Review diffs.",
  allowedTools: ["Read", "Grep"],
  model: null,
  isBuiltin: true,
  createdByMemberId: "mem_human",
  createdAt: new Date(0),
};

function makeService(over: Partial<SubagentServiceDeps> = {}) {
  const launch = vi.fn().mockResolvedValue({ id: "sess_1" });
  const launcher: SubagentLauncher = { launch };
  const caps: Record<string, Capability> = { mem_human: "propagate", mem_reviewer: "write" };
  const deps: SubagentServiceDeps = {
    getPersona: vi.fn().mockResolvedValue(PERSONA),
    getChannelWorkspace: vi.fn().mockResolvedValue("ws_1"),
    channelCapabilityFor: vi.fn(async (_ws: string, memberId: string) => caps[memberId] ?? null),
    mentionedMemberIds: vi.fn().mockResolvedValue(["mem_reviewer"]),
    launcher,
    ...over,
  };
  return { service: new SubagentService(deps), launch, deps };
}

describe("SubagentService.invoke (#59)", () => {
  it("launches the session AS the persona member, threaded under the invoking message", async () => {
    const { service, launch } = makeService();
    const res = await service.invoke(IDENTITY, {
      personaId: "per_1",
      channelId: "ch_1",
      task: "review this diff",
      messageId: "msg_invoke",
    });
    expect(res).toEqual({ ok: true, sessionId: "sess_1" });
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        channelId: "ch_1",
        agentMemberId: "mem_reviewer",
        createdByMemberId: "mem_human",
        task: "review this diff",
        parentMessageId: "msg_invoke",
        harnessEnv: {
          AGENT_APPEND_SYSTEM_PROMPT: "Review diffs.",
          AGENT_ALLOWED_TOOLS: "Read,Grep,WebFetch,WebSearch", // #250 web tools unioned in
        },
      }),
    );
  });

  it("rejects with 403 when the invoker lacks propagate (delegation right) — never launches", async () => {
    const { service, launch } = makeService({
      channelCapabilityFor: vi.fn(async (_ws: string, memberId: string) =>
        memberId === "mem_human" ? "write" : "write",
      ),
    });
    const res = await service.invoke(IDENTITY, { personaId: "per_1", channelId: "ch_1", task: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(403);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the persona is not permitted in the channel — never launches", async () => {
    const { service, launch } = makeService({
      channelCapabilityFor: vi.fn(async (_ws: string, memberId: string) =>
        memberId === "mem_human" ? "propagate" : null,
      ),
    });
    const res = await service.invoke(IDENTITY, { personaId: "per_1", channelId: "ch_1", task: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(403);
    expect(launch).not.toHaveBeenCalled();
  });

  it("404s a persona from another workspace (IDOR) — never launches", async () => {
    const { service, launch } = makeService({ getPersona: vi.fn().mockResolvedValue(undefined) });
    const res = await service.invoke(IDENTITY, { personaId: "per_x", channelId: "ch_1", task: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it("404s a channel in another workspace before any persona work (IDOR)", async () => {
    const { service, launch } = makeService({ getChannelWorkspace: vi.fn().mockResolvedValue("ws_other") });
    const res = await service.invoke(IDENTITY, { personaId: "per_1", channelId: "ch_x", task: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it("400s when messageId is given but the persona is not mentioned on it", async () => {
    const { service, launch } = makeService({ mentionedMemberIds: vi.fn().mockResolvedValue(["mem_other"]) });
    const res = await service.invoke(IDENTITY, {
      personaId: "per_1",
      channelId: "ch_1",
      task: "x",
      messageId: "msg_invoke",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(400);
    expect(launch).not.toHaveBeenCalled();
  });

  it("narrows a tool request to the persona ceiling before launch (cannot widen)", async () => {
    const { service, launch } = makeService();
    await service.invoke(IDENTITY, {
      personaId: "per_1",
      channelId: "ch_1",
      task: "x",
      tools: ["Read", "Bash", "Write"], // Bash/Write outside the ["Read","Grep"] ceiling
    });
    // Narrowing still holds (Bash/Write are dropped); #250 only ADDS the read-only web tools on top.
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessEnv: expect.objectContaining({ AGENT_ALLOWED_TOOLS: "Read,WebFetch,WebSearch" }),
      }),
    );
  });
});
