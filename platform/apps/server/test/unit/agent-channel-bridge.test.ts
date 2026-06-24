import { describe, it, expect } from "vitest";
import { composePost, sanitizeData, MAX_DATA_CHARS } from "../../src/agent-channel-bridge/compose.js";
import { CoordinationChannelBridge } from "../../src/agent-channel-bridge/bridge.js";
import type { CoordinationBridgeDeps } from "../../src/agent-channel-bridge/bridge.js";
import type { CoordinationEvent } from "../../src/agent-channel-bridge/events.js";
import type { AgentChannelPostingCaps } from "../../src/agent-channel-bridge/caps.js";
import { observeBridgeResult } from "../../src/agent-channel-bridge/observe.js";

/**
 * #370 — the pure composer turns coordination events into sanitized, text-only channel lines, and the
 * gated dispatcher posts them AS the acting agent. Both are pure/seam-driven ⇒ tested without a DB/DOM.
 */
describe("composePost (#370) — text-only, sanitized DATA", () => {
  it("lead_plan: authors as the lead, in its channel, embedding the (sanitized) goal", () => {
    const post = composePost({
      kind: "lead_plan",
      channel: "seo",
      agentHandle: "scout",
      goal: "get us paying founders for ipop.ai",
    });
    expect(post.channel).toBe("seo");
    expect(post.authorHandle).toBe("scout");
    expect(post.body).toContain("get us paying founders for ipop.ai");
    expect(post.body).toContain("#13 approval gate");
  });

  it("handoff: the delegating agent posts a line naming the receiver", () => {
    const post = composePost({
      kind: "handoff",
      channel: "content",
      agentHandle: "scout",
      toHandle: "quill",
      task: "draft the launch blog",
    });
    expect(post.authorHandle).toBe("scout");
    expect(post.body).toContain("@quill");
    expect(post.body).toContain("draft the launch blog");
  });

  it("task_created: an inline task card linking the task id, authored by the assignee", () => {
    const post = composePost({
      kind: "task_created",
      channel: "content",
      agentHandle: "quill",
      taskId: "T-123",
      title: "Write the FAQ",
      assigneeHandle: "quill",
    });
    expect(post.body).toContain("T-123");
    expect(post.body).toContain("Write the FAQ");
    expect(post.body).toContain("@quill");
  });

  it("approval_required: @mentions the owner and points at the EXISTING #13 gate (not a new action)", () => {
    const post = composePost(
      {
        kind: "approval_required",
        channel: "ads",
        agentHandle: "bid",
        approvalRequestId: "req-9",
        summary: "Spend $500 on a Google Ads campaign",
      },
      { ownerName: "Gagan" },
    );
    expect(post.body.startsWith("@Gagan ")).toBe(true);
    expect(post.body).toContain("req-9");
    expect(post.body).toContain("not a new action");
  });

  it("approval_required: omits the @mention gracefully when there is no owner name", () => {
    const post = composePost({
      kind: "approval_required",
      channel: "ads",
      agentHandle: "bid",
      approvalRequestId: "req-9",
      summary: "Spend $500",
    });
    expect(post.body.startsWith("@")).toBe(false);
    expect(post.body).toContain("#13 approval gate");
  });

  it("sanitizeData neutralizes control chars + collapses whitespace (injection defense, #200 §6)", () => {
    // Build the dirty input from char codes so no literal control byte lands in the source file.
    const NL = String.fromCharCode(0x0a);
    const TAB = String.fromCharCode(0x09);
    const BEL = String.fromCharCode(0x07);
    const dirty = `line one${NL}line${TAB}two${BEL}   spaced`;
    const clean = sanitizeData(dirty);
    // No char in the cleaned output is a C0/C1 control character.
    for (const ch of clean) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code < 0x20 || (code >= 0x7f && code <= 0x9f)).toBe(false);
    }
    expect(clean).toBe("line one line two spaced");
  });

  it("sanitizeData hard-caps the length with an ellipsis", () => {
    const long = "x".repeat(MAX_DATA_CHARS + 50);
    const clean = sanitizeData(long);
    expect(clean.length).toBe(MAX_DATA_CHARS + 1); // capped slice + the "…" marker
    expect(clean.endsWith("…")).toBe(true);
  });
});

// --- the gated, fail-closed dispatcher ----------------------------------------------------------

const ENABLED: AgentChannelPostingCaps = {
  enabled: true,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: "owner-ws",
};

function makeDeps(over: Partial<CoordinationBridgeDeps> = {}): {
  deps: CoordinationBridgeDeps;
  posts: Array<{ channelId: string; authorMemberId: string; body: string }>;
} {
  const posts: Array<{ channelId: string; authorMemberId: string; body: string }> = [];
  const deps: CoordinationBridgeDeps = {
    caps: () => ENABLED,
    resolveChannelId: async (_w, name) => (name === "seo" ? "chan-seo" : undefined),
    resolveAgentMember: async (_w, handle) => (handle === "scout" ? { memberId: "m-scout" } : undefined),
    resolveOwnerName: async () => "Gagan",
    post: async (input) => {
      posts.push({ channelId: input.channelId, authorMemberId: input.authorMemberId, body: input.body });
      return { id: "msg-1" };
    },
    ...over,
  };
  return { deps, posts };
}

const LEAD_PLAN: CoordinationEvent = {
  kind: "lead_plan",
  channel: "seo",
  agentHandle: "scout",
  goal: "win",
};

describe("CoordinationChannelBridge (#370) — gated, fail-closed, best-effort", () => {
  it("posts as the resolved agent member when enabled for the workspace", async () => {
    const { deps, posts } = makeDeps();
    const bridge = new CoordinationChannelBridge(deps);
    const res = await bridge.post("owner-ws", LEAD_PLAN);
    expect(res).toEqual({
      posted: true,
      messageId: "msg-1",
      channelId: "chan-seo",
      authorMemberId: "m-scout",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.authorMemberId).toBe("m-scout");
  });

  it("no-ops for a non-owner workspace (owner-first) without touching the channel", async () => {
    const { deps, posts } = makeDeps();
    const bridge = new CoordinationChannelBridge(deps);
    const res = await bridge.post("other-ws", LEAD_PLAN);
    expect(res).toEqual({ posted: false, reason: "disabled" });
    expect(posts).toHaveLength(0);
  });

  it("no-ops when the master flag is off (default)", async () => {
    const { deps, posts } = makeDeps({
      caps: () => ({ enabled: false, ownerWorkspaceOnly: true, ownerWorkspaceId: "owner-ws" }),
    });
    const bridge = new CoordinationChannelBridge(deps);
    const res = await bridge.post("owner-ws", LEAD_PLAN);
    expect(res).toEqual({ posted: false, reason: "disabled" });
    expect(posts).toHaveLength(0);
  });

  it("no-channel when the department channel isn't seeded", async () => {
    const { deps } = makeDeps({ resolveChannelId: async () => undefined });
    const bridge = new CoordinationChannelBridge(deps);
    expect(await bridge.post("owner-ws", LEAD_PLAN)).toEqual({ posted: false, reason: "no-channel" });
  });

  it("no-author when the @handle resolves to no active agent member", async () => {
    const { deps } = makeDeps({ resolveAgentMember: async () => undefined });
    const bridge = new CoordinationChannelBridge(deps);
    expect(await bridge.post("owner-ws", LEAD_PLAN)).toEqual({ posted: false, reason: "no-author" });
  });

  it("resolves the owner name ONLY for an approval @mention", async () => {
    let ownerResolved = 0;
    const { deps, posts } = makeDeps({
      resolveChannelId: async () => "chan-seo",
      resolveAgentMember: async () => ({ memberId: "m-bid" }),
      resolveOwnerName: async () => {
        ownerResolved += 1;
        return "Gagan";
      },
    });
    const bridge = new CoordinationChannelBridge(deps);
    await bridge.post("owner-ws", LEAD_PLAN);
    expect(ownerResolved).toBe(0); // not resolved for a lead plan
    await bridge.post("owner-ws", {
      kind: "approval_required",
      channel: "seo",
      agentHandle: "bid",
      approvalRequestId: "req-1",
      summary: "spend",
    });
    expect(ownerResolved).toBe(1);
    expect(posts.at(-1)!.body.startsWith("@Gagan ")).toBe(true);
  });

  it("never throws — a failing post is reported, not raised (best-effort on audited paths)", async () => {
    const { deps } = makeDeps({
      post: async () => {
        throw new Error("db down");
      },
    });
    const bridge = new CoordinationChannelBridge(deps);
    expect(await bridge.post("owner-ws", LEAD_PLAN)).toEqual({ posted: false, reason: "error" });
  });
});

describe("observeBridgeResult (#933) — failed bridge posts are visible", () => {
  const events: CoordinationEvent[] = [
    {
      kind: "handoff",
      channel: "content",
      agentHandle: "scout",
      toHandle: "quill",
      task: "draft the launch blog",
    },
    {
      kind: "task_created",
      channel: "content",
      agentHandle: "quill",
      taskId: "task-1",
      title: "Draft launch blog",
      assigneeHandle: "quill",
    },
    {
      kind: "approval_required",
      channel: "ads",
      agentHandle: "bid",
      approvalRequestId: "req-1",
      summary: "Spend $500",
    },
    {
      kind: "lead_plan",
      channel: "seo",
      agentHandle: "scout",
      goal: "Find paying founders",
    },
  ];

  it.each(events.map((event) => [event.kind, event] as const))(
    "logs %s delivery failures with the bridge reason",
    (_kind, event) => {
      const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
      observeBridgeResult(
        {
          warn(fields, message) {
            warnings.push({ fields, message });
          },
        },
        "ws-1",
        event,
        { posted: false, reason: "no-channel" },
        { taskId: "task-1" },
      );

      expect(warnings).toEqual([
        {
          fields: {
            taskId: "task-1",
            workspaceId: "ws-1",
            kind: event.kind,
            channel: event.channel,
            reason: "no-channel",
          },
          message: "coordination bridge post not delivered",
        },
      ]);
    },
  );

  it("stays quiet for delivered posts", () => {
    const warnings: unknown[] = [];
    observeBridgeResult(
      {
        warn(fields, message) {
          warnings.push({ fields, message });
        },
      },
      "ws-1",
      events[0]!,
      { posted: true, messageId: "msg-1", channelId: "chan-1", authorMemberId: "m-1" },
    );

    expect(warnings).toHaveLength(0);
  });
});
