import { describe, it, expect, vi } from "vitest";
import {
  handleHumanMentionPost,
  offChannelNotice,
  launchDeniedNotice,
  type MentionTriggerDeps,
  type AddressedPersona,
} from "../../../src/marketing/mention-trigger.js";

const scout: AddressedPersona = { agentMemberId: "ag-scout", name: "scout", homeChannel: "seo" };

function deps(over: Partial<MentionTriggerDeps> = {}): MentionTriggerDeps {
  return {
    isMarketingChannel: (name) => name === "seo" || name === "content",
    launch: vi.fn(async () => ({ ok: true, launched: [], connectPrompted: [], modelBlocked: [], deduped: [] })),
    addressedDepartmentPersonas: vi.fn(async () => []),
    postNotice: vi.fn(async () => {}),
    ...over,
  };
}

const ID = { workspaceId: "w1", memberId: "u1" };

describe("handleHumanMentionPost (#468 no silent drops)", () => {
  it("marketing channel + addressed agent ⇒ launches, posts no notice on success", async () => {
    const d = deps({ addressedDepartmentPersonas: vi.fn(async () => [scout]) });
    await handleHumanMentionPost(d, ID, { id: "c-seo", name: "seo" }, { id: "m1", body: "@scout audit" });
    expect(d.launch).toHaveBeenCalledWith({ channelId: "c-seo", messageId: "m1", task: "@scout audit" });
    expect(d.postNotice).not.toHaveBeenCalled();
  });

  it("marketing channel + launch DENIED ⇒ surfaces the reason in-channel (not swallowed)", async () => {
    const d = deps({
      addressedDepartmentPersonas: vi.fn(async () => [scout]),
      launch: vi.fn(async () => ({ ok: false, code: 403, error: "channel access denied" })),
    });
    await handleHumanMentionPost(d, ID, { id: "c-seo", name: "seo" }, { id: "m1", body: "@scout audit" });
    expect(d.postNotice).toHaveBeenCalledTimes(1);
    const arg = (d.postNotice as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.agentMemberId).toBe("ag-scout");
    expect(arg.body).toContain("channel access denied");
    expect(arg.parentMessageId).toBe("m1");
  });

  it("NON-marketing channel + addressed agent ⇒ posts an honest redirect, never a silent drop", async () => {
    const d = deps({ addressedDepartmentPersonas: vi.fn(async () => [scout]) });
    await handleHumanMentionPost(d, ID, { id: "c-qa", name: "qa-test" }, { id: "m1", body: "scout, ack please" });
    // It does NOT launch outside the home channel…
    expect(d.launch).not.toHaveBeenCalled();
    // …but the user always gets a visible reply telling them where to reach the agent.
    expect(d.postNotice).toHaveBeenCalledTimes(1);
    const arg = (d.postNotice as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.channelId).toBe("c-qa");
    expect(arg.agentMemberId).toBe("ag-scout");
    expect(arg.body).toContain("#seo");
  });

  it("NON-marketing channel + NO agent addressed ⇒ genuine no-op (human-to-human message)", async () => {
    const d = deps({ addressedDepartmentPersonas: vi.fn(async () => []) });
    await handleHumanMentionPost(d, ID, { id: "c-qa", name: "qa-test" }, { id: "m1", body: "morning team" });
    expect(d.launch).not.toHaveBeenCalled();
    expect(d.postNotice).not.toHaveBeenCalled();
  });
});

describe("notice copy", () => {
  it("offChannelNotice names the agent and its home channel", () => {
    expect(offChannelNotice("scout", "seo")).toContain("Scout");
    expect(offChannelNotice("scout", "seo")).toContain("#seo");
  });

  it("launchDeniedNotice carries the reason, with a graceful fallback when empty", () => {
    expect(launchDeniedNotice("quill", "budget exhausted")).toContain("budget exhausted");
    expect(launchDeniedNotice("quill", "  ")).toContain("capacity");
  });
});
