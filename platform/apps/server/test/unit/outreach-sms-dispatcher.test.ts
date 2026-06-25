import { describe, expect, it } from "vitest";
import {
  TwilioSmsSender,
  dryRunSmsSender,
  type TwilioTransport,
} from "../../src/outreach/send-dispatcher.js";

describe("outreach SMS dispatcher (#892)", () => {
  it("records a deterministic dry-run SMS receipt without network", async () => {
    const input = {
      to: "sms:contact-9",
      body: "Hi Dana - quick reminder?",
      recipientRef: "sms:contact-9",
    };
    const a = await dryRunSmsSender.send(input);
    const b = await dryRunSmsSender.send(input);
    expect(a.provider).toBe("dryrun");
    expect(a.externalId).toMatch(/^dry_sms_/);
    expect(a.externalId).toBe(b.externalId);
    expect(a.detail).toContain("no network");
  });

  it("uses the injected Twilio transport when credentials are present", async () => {
    const calls: Array<{ from: string; to: string; body: string }> = [];
    const transport: TwilioTransport = {
      async send(input) {
        calls.push({ from: input.from, to: input.to, body: input.body });
        return { sid: "SM123" };
      },
    };
    const sender = new TwilioSmsSender(
      { accountSid: "AC123", authToken: "tok", from: "+15551234567" },
      transport,
    );
    const out = await sender.send({
      to: "+15557654321",
      body: "Hi Dana - reminder?",
      recipientRef: "sms:+15557654321",
    });
    expect(out).toEqual({ provider: "twilio", externalId: "SM123", detail: "SMS sent via Twilio" });
    expect(calls).toEqual([{ from: "+15551234567", to: "+15557654321", body: "Hi Dana - reminder?" }]);
  });
});
