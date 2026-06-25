import { describe, it, expect } from "vitest";
import { dryRunEspSender } from "../../../src/reach/channels/email.js";
import { REACH_DEFAULTS, type ReachCaps } from "../../../src/reach/caps.js";
import { resolveReachLinkedInSender, resolveReachPostmarkSender } from "../../../src/reach/default.js";

const LIVE_CAPS: ReachCaps = {
  ...REACH_DEFAULTS,
  enabled: true,
  sendProvider: "postmark",
  liveSendEnabled: true,
  brandName: "ipop",
  postalAddress: "1 Market St, San Francisco, CA",
  unsubscribeUrl: "https://ipop.ai/unsubscribe",
};

describe("Reach default email sender wiring (#850)", () => {
  it("keeps the dry-run sender when Reach live send is OFF", () => {
    const sender = resolveReachPostmarkSender({
      caps: { ...LIVE_CAPS, liveSendEnabled: false },
      secrets: { POSTMARK_SERVER_TOKEN: "pm-token", POSTMARK_FROM: "hello@ipop.ai" },
    });

    expect(sender).toBe(dryRunEspSender);
  });

  it("keeps the dry-run sender when Postmark credentials are missing", () => {
    const sender = resolveReachPostmarkSender({
      caps: LIVE_CAPS,
      secrets: { POSTMARK_SERVER_TOKEN: "pm-token" },
    });

    expect(sender).toBe(dryRunEspSender);
  });

  it("constructs the live Postmark sender when enabled and vault credentials are present", () => {
    const sender = resolveReachPostmarkSender({
      caps: LIVE_CAPS,
      secrets: { POSTMARK_SERVER_TOKEN: "pm-token", POSTMARK_FROM: "hello@ipop.ai" },
    });

    expect(sender.kind).toBe("postmark");
    expect(sender).not.toBe(dryRunEspSender);
  });

  it("uses a configured sender pool address when the legacy From secret is absent (#907)", () => {
    const sender = resolveReachPostmarkSender({
      caps: {
        ...LIVE_CAPS,
        sendingDomains: [
          { from: "founder@warm.example", domain: "warm.example", dailyCap: 25, enabled: true },
        ],
      },
      secrets: { POSTMARK_SERVER_TOKEN: "pm-token" },
    });

    expect(sender.kind).toBe("postmark");
    expect(sender).not.toBe(dryRunEspSender);
  });
});

describe("Reach default LinkedIn sender wiring (#856)", () => {
  it("keeps LinkedIn queue-only when live send is OFF", () => {
    expect(
      resolveReachLinkedInSender({
        caps: { ...LIVE_CAPS, linkedinSendProvider: "api", linkedinLiveSendEnabled: false },
        secrets: {
          LINKEDIN_API_TOKEN: "li-token",
          LINKEDIN_API_BASE_URL: "https://api.linkedin.example",
        },
      }),
    ).toBeUndefined();
  });

  it("keeps LinkedIn queue-only when vault credentials are missing", () => {
    expect(
      resolveReachLinkedInSender({
        caps: { ...LIVE_CAPS, linkedinSendProvider: "api", linkedinLiveSendEnabled: true },
        secrets: { LINKEDIN_API_TOKEN: "li-token" },
      }),
    ).toBeUndefined();
  });

  it("constructs the permitted LinkedIn API sender when enabled and vault credentials are present", () => {
    const sender = resolveReachLinkedInSender({
      caps: { ...LIVE_CAPS, linkedinSendProvider: "api", linkedinLiveSendEnabled: true },
      secrets: {
        LINKEDIN_API_TOKEN: "li-token",
        LINKEDIN_API_BASE_URL: "https://api.linkedin.example",
      },
    });

    expect(sender?.kind).toBe("linkedin-api");
  });
});
