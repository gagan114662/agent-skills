import { describe, it, expect } from "vitest";
import {
  LOWEST_RISK_CHANNEL,
  OUTBOUND_CHANNELS,
  channelForEspProvider,
  getChannelDescriptor,
  isOutboundChannel,
} from "../../src/outbound-channel/channel.js";

describe("outbound-channel catalogue", () => {
  it("ships real email lanes while keeping Postmark as the lowest-risk default", () => {
    expect(OUTBOUND_CHANNELS).toEqual(["email_postmark", "email_resend"]);
    expect(LOWEST_RISK_CHANNEL).toBe("email_postmark");
  });

  it("isOutboundChannel is a closed allow-list", () => {
    expect(isOutboundChannel("email_postmark")).toBe(true);
    expect(isOutboundChannel("email_resend")).toBe(true);
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
    expect(getChannelDescriptor("email_resend")).toMatchObject({
      provider: "resend",
      credentialEnvKey: "RESEND_API_KEY",
      spendsMoney: false,
    });
  });

  it("maps real ESP providers back to outbound channel ids", () => {
    expect(channelForEspProvider("postmark")).toBe("email_postmark");
    expect(channelForEspProvider("resend")).toBe("email_resend");
    expect(channelForEspProvider("dryrun")).toBeNull();
  });

  it("returns null for an unknown channel", () => {
    expect(getChannelDescriptor("nope")).toBeNull();
  });
});
