import { describe, it, expect } from "vitest";
import {
  LOWEST_RISK_CHANNEL,
  OUTBOUND_CHANNELS,
  getChannelDescriptor,
  isOutboundChannel,
} from "../../src/outbound-channel/channel.js";

describe("outbound-channel catalogue", () => {
  it("ships exactly one channel — the lowest-risk Postmark email lane", () => {
    expect(OUTBOUND_CHANNELS).toEqual(["email_postmark"]);
    expect(LOWEST_RISK_CHANNEL).toBe("email_postmark");
  });

  it("isOutboundChannel is a closed allow-list", () => {
    expect(isOutboundChannel("email_postmark")).toBe(true);
    expect(isOutboundChannel("x_timeline")).toBe(false);
    expect(isOutboundChannel("")).toBe(false);
    expect(isOutboundChannel(null)).toBe(false);
    expect(isOutboundChannel(42)).toBe(false);
  });

  it("the email descriptor names the owner-gated env credential but never a value, and never spends money", () => {
    const d = getChannelDescriptor("email_postmark");
    expect(d).not.toBeNull();
    expect(d?.provider).toBe("postmark");
    expect(d?.credentialEnvKey).toBe("POSTMARK_SERVER_TOKEN");
    expect(d?.spendsMoney).toBe(false);
  });

  it("returns null for an unknown channel", () => {
    expect(getChannelDescriptor("nope")).toBeNull();
  });
});
