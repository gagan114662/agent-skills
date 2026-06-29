import { describe, expect, it } from "vitest";
import { emailOutboundConfigIssue } from "../../src/connections/email-readiness.js";

describe("email outbound readiness", () => {
  it("names every missing live-send setting before customer acquisition can go live", () => {
    const issue = emailOutboundConfigIssue({ reach: undefined, env: {} });

    expect(issue).toMatchObject({
      code: "email_outbound_live_send_missing_config",
      missingEnv: expect.arrayContaining([
        "RELOAD_REACH_SEND_PROVIDER=postmark or resend",
        "RELOAD_REACH_LIVE_SEND_ENABLED=1",
        "POSTMARK_SERVER_TOKEN + sender or RESEND_API_KEY + sender",
        "RELOAD_ACQUISITION_ENABLED=true",
        "RELOAD_ACQUISITION_EMAIL=true",
        "RELOAD_ACQUISITION_ESP_PROVIDER=postmark or resend",
        "RELOAD_ACQUISITION_BRAND_NAME",
        "RELOAD_ACQUISITION_POSTAL_ADDRESS",
        "RELOAD_ACQUISITION_UNSUBSCRIBE_URL",
      ]),
      remedy: expect.stringContaining("enable reach live-send and acquisition email"),
    });
  });

  it("clears the blocker when Postmark, reach, acquisition, and compliance config are present", () => {
    const issue = emailOutboundConfigIssue({
      reach: { sendProvider: "postmark", liveSendEnabled: true },
      env: {
        POSTMARK_SERVER_TOKEN: "pm-secret",
        POSTMARK_FROM: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "postmark",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    expect(issue).toBeUndefined();
  });

  it("clears the blocker when Resend, reach, acquisition, and compliance config are present", () => {
    const issue = emailOutboundConfigIssue({
      reach: { sendProvider: "resend", liveSendEnabled: true },
      env: {
        RESEND_API_KEY: "re-secret",
        RELOAD_FLEET_FROM_EMAIL: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "resend",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    expect(issue).toBeUndefined();
  });

  it("requires reach and acquisition to pick the same live ESP", () => {
    const issue = emailOutboundConfigIssue({
      reach: { sendProvider: "resend", liveSendEnabled: true },
      env: {
        RESEND_API_KEY: "re-secret",
        RELOAD_FLEET_FROM_EMAIL: "hello@ipop.ai",
        RELOAD_ACQUISITION_ENABLED: "true",
        RELOAD_ACQUISITION_EMAIL: "true",
        RELOAD_ACQUISITION_ESP_PROVIDER: "postmark",
        RELOAD_ACQUISITION_BRAND_NAME: "ipop",
        RELOAD_ACQUISITION_POSTAL_ADDRESS: "1 Market St, San Francisco, CA",
        RELOAD_ACQUISITION_UNSUBSCRIBE_URL: "https://ipop.ai/unsubscribe",
      },
    });

    expect(issue?.missingEnv).toContain("RELOAD_ACQUISITION_ESP_PROVIDER=resend");
  });
});
