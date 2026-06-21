import { describe, it, expect } from "vitest";
import {
  isChannelFlagLive,
  isWorkspaceInRolloutScope,
  resolveOutboundChannelFlags,
} from "../../src/outbound-channel/flags.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("outbound-channel flags", () => {
  it("defaults everything OFF when there is no acquisition block", () => {
    const f = resolveOutboundChannelFlags(undefined);
    expect(f.globalEnabled).toBe(false);
    expect(f.emailEnabled).toBe(false);
    expect(f.ownerWorkspaceId).toBeNull();
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(false);
  });

  it("defaults everything OFF for an empty acquisition block (the resolved default)", () => {
    const f = resolveOutboundChannelFlags({});
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(false);
  });

  it("the global master switch is required even when the per-channel switch is on", () => {
    const f = resolveOutboundChannelFlags({ enabled: false, email: true });
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(false);
  });

  it("the per-channel switch is required even when the global master switch is on", () => {
    const f = resolveOutboundChannelFlags({ enabled: true, email: false });
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(false);
  });

  it("is live only when BOTH switches are on", () => {
    const f = resolveOutboundChannelFlags({ enabled: true, email: true });
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(true);
  });

  it("respects owner-workspace-first rollout when an owner workspace is pinned", () => {
    const f = resolveOutboundChannelFlags({ enabled: true, email: true, ownerWorkspaceId: WS });
    expect(isWorkspaceInRolloutScope(f, WS)).toBe(true);
    expect(isWorkspaceInRolloutScope(f, OTHER)).toBe(false);
    expect(isChannelFlagLive(f, "email_postmark", WS)).toBe(true);
    expect(isChannelFlagLive(f, "email_postmark", OTHER)).toBe(false);
  });

  it("treats a blank owner workspace id as no pin (every workspace in scope)", () => {
    const f = resolveOutboundChannelFlags({ enabled: true, email: true, ownerWorkspaceId: "" });
    expect(f.ownerWorkspaceId).toBeNull();
    expect(isChannelFlagLive(f, "email_postmark", OTHER)).toBe(true);
  });
});
