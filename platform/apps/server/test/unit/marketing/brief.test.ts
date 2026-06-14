import { describe, it, expect, vi } from "vitest";
import { MarketingBriefService, type MarketingBriefDeps } from "../../../src/marketing/brief.js";

/**
 * #235 owner brief → real session. The brief composer is a thin, deterministic front door onto the
 * audited #123 @mention launch: it posts the owner's brief into the lead's channel, persists the
 * @mention, then runs the SAME launch path (injected here as `launch`). These tests pin: the brief
 * becomes `@<lead> <goal>` posted by the owner; the @mention is persisted before launching; the launched
 * sessions are returned; an empty goal / unknown lead / unseeded department are rejected without posting;
 * and a launch denial propagates with the brief already on the record.
 */
const identity = { workspaceId: "ws-1", memberId: "owner-1" };

function baseDeps(over: Partial<MarketingBriefDeps> = {}): {
  deps: MarketingBriefDeps;
  post: ReturnType<typeof vi.fn>;
  recordMentions: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async () => ({ id: "msg-1" }));
  const recordMentions = vi.fn(async () => undefined);
  const launch = vi.fn(async () => ({
    ok: true as const,
    launched: [{ personaId: "p-scout", handle: "scout", department: "seo", sessionId: "sess-1", taskId: "mt-1" }],
    connectPrompted: [],
  }));
  const deps: MarketingBriefDeps = {
    resolveLead: (h) => (h === "scout" ? { handle: "scout", department: "seo", channel: "seo" } : undefined),
    getChannelByName: async (_w, name) => (name === "seo" ? { id: "c-seo" } : undefined),
    post,
    recordMentions,
    launch,
    ...over,
  };
  return { deps, post, recordMentions, launch };
}

describe("#235 MarketingBriefService", () => {
  it("posts @lead goal as the owner, persists the mention, then launches and returns the sessions", async () => {
    const { deps, post, recordMentions, launch } = baseDeps();
    const res = await new MarketingBriefService(deps).brief(identity, {
      lead: "scout",
      goal: "go get us paying founders for ipop.ai",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res).toMatchObject({ lead: "scout", department: "seo", channelId: "c-seo", messageId: "msg-1" });
    expect(res.launched).toHaveLength(1);

    expect(post).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      channelId: "c-seo",
      authorMemberId: "owner-1",
      body: "@scout go get us paying founders for ipop.ai",
    });
    // The mention is persisted BEFORE the launch (so the launch path can resolve the lead).
    const postOrder = post.mock.invocationCallOrder[0]!;
    const recordOrder = recordMentions.mock.invocationCallOrder[0]!;
    const launchOrder = launch.mock.invocationCallOrder[0]!;
    expect(postOrder).toBeLessThan(recordOrder);
    expect(recordOrder).toBeLessThan(launchOrder);
    expect(launch).toHaveBeenCalledWith(identity, {
      channelId: "c-seo",
      messageId: "msg-1",
      task: "go get us paying founders for ipop.ai",
    });
  });

  it("normalises a leading @ and case on the lead handle", async () => {
    const { deps, post } = baseDeps();
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "@Scout", goal: "rank us" });
    expect(res.ok).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ body: "@scout rank us" }));
  });

  it("400s an empty goal without posting or launching", async () => {
    const { deps, post, launch } = baseDeps();
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "scout", goal: "   " });
    expect(res).toMatchObject({ ok: false, code: 400 });
    expect(post).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("400s an unknown department lead without posting", async () => {
    const { deps, post } = baseDeps();
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "nobody", goal: "do a thing" });
    expect(res).toMatchObject({ ok: false, code: 400 });
    expect(post).not.toHaveBeenCalled();
  });

  it("409s when the department channel hasn't been seeded yet (fleet not hired)", async () => {
    const { deps, post } = baseDeps({ getChannelByName: async () => undefined });
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "scout", goal: "do a thing" });
    expect(res).toMatchObject({ ok: false, code: 409 });
    expect(post).not.toHaveBeenCalled();
  });

  it("propagates a launch RBAC denial (the brief is posted, the work is not)", async () => {
    const { deps, post } = baseDeps({
      launch: vi.fn(async () => ({ ok: false as const, code: 403, error: "not permitted" })) as never,
    });
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "scout", goal: "do a thing" });
    expect(res).toMatchObject({ ok: false, code: 403 });
    // The brief message is on the record even though no session launched.
    expect(post).toHaveBeenCalled();
  });

  it("lets a kill-switch/budget denial throw out (so the route maps it to 402/429)", async () => {
    const { deps } = baseDeps({
      launch: vi.fn(async () => {
        throw new Error("launch denied: budget_exceeded");
      }) as never,
    });
    await expect(
      new MarketingBriefService(deps).brief(identity, { lead: "scout", goal: "do a thing" }),
    ).rejects.toThrow(/budget_exceeded/);
  });

  it("surfaces a connect-prompt (no Claude connected) as a successful brief with no launched sessions", async () => {
    const { deps } = baseDeps({
      launch: vi.fn(async () => ({
        ok: true as const,
        launched: [],
        connectPrompted: [{ personaId: "p-scout", handle: "scout", department: "seo", messageId: "cp-1" }],
      })) as never,
    });
    const res = await new MarketingBriefService(deps).brief(identity, { lead: "scout", goal: "rank us" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.launched).toHaveLength(0);
    expect(res.connectPrompted).toHaveLength(1);
  });
});
