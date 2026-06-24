import { describe, it, expect } from "vitest";
import { createEmailChannel, dryRunEspSender, type EspSender } from "../../../src/reach/channels/email.js";
import { createLinkedInChannel, type LinkedInSender } from "../../../src/reach/channels/linkedin.js";
import type { ChannelSendContext } from "../../../src/reach/channel.js";
import type { ReachMessage } from "../../../src/reach/types.js";

const FOOTER = {
  brandName: "ipop",
  postalAddress: "1 Market St, SF, CA",
  unsubscribeUrl: "https://ipop.ai/u",
};

function emailMsg(over: Partial<ReachMessage> = {}): ReachMessage {
  return {
    contactKey: "email:jane@acme.com",
    channel: "email",
    toAddress: "jane@acme.com",
    recipientLabel: "Jane · Acme",
    subject: "A quick idea for Acme",
    body: "Hi Jane,\n\nWorth a chat?\n\n— ipop",
    variant: "pain",
    signalKind: "funding_round",
    ...over,
  };
}

function ctx(over: Partial<ChannelSendContext> = {}): ChannelSendContext {
  return { workspaceId: "ws-1", suppressed: new Set(), footerInfo: FOOTER, ...over };
}

describe("email channel — suppression + compliance (#280)", () => {
  it("sends (dry-run, recorded-only) with a CAN-SPAM footer + per-recipient unsubscribe token", async () => {
    const ch = createEmailChannel();
    let capturedBody = "";
    const sender: EspSender = {
      kind: "dryrun",
      async send(input) {
        capturedBody = input.body;
        return { externalId: "x" };
      },
    };
    const out = await createEmailChannel({ sender }).send(emailMsg(), ctx());
    expect(out.status).toBe("sent");
    expect(capturedBody).toContain("Unsubscribe: https://ipop.ai/u?u="); // working, per-recipient link
    expect(capturedBody).toContain("1 Market St"); // postal address (CAN-SPAM)
    // default dry-run sender produces a deterministic recorded-only id, no network
    expect((await ch.send(emailMsg(), ctx())).externalId).toMatch(/^dryrun-email-/);
  });

  it("blocks a suppressed/opted-out recipient", async () => {
    const out = await createEmailChannel().send(emailMsg(), ctx({ suppressed: new Set(["jane@acme.com"]) }));
    expect(out.status).toBe("suppressed");
  });

  it("skips when footer facts are incomplete (no unlawful send)", async () => {
    const out = await createEmailChannel().send(emailMsg(), ctx({ footerInfo: { brandName: "ipop" } }));
    expect(out.status).toBe("skipped");
    expect(out.detail).toContain("CAN-SPAM");
  });

  it("skips when there is no address", async () => {
    const out = await createEmailChannel().send(emailMsg({ toAddress: "" }), ctx());
    expect(out.status).toBe("skipped");
  });

  it("reports a provider failure as failed (never a silent success)", async () => {
    const sender: EspSender = {
      kind: "boom",
      async send() {
        throw new Error("smtp down");
      },
    };
    const out = await createEmailChannel({ sender }).send(emailMsg(), ctx());
    expect(out.status).toBe("failed");
    expect(out.detail).toContain("smtp down");
  });

  it("resolves the sender per workspace at send time", async () => {
    const seen: string[] = [];
    const sender: EspSender = {
      kind: "postmark",
      async send() {
        return { externalId: "pm-live-1" };
      },
    };
    const out = await createEmailChannel({
      resolveSender(ctx) {
        seen.push(ctx.workspaceId);
        return sender;
      },
    }).send(emailMsg(), ctx({ workspaceId: "ws-live" }));

    expect(out.status).toBe("sent");
    expect(out.externalId).toBe("pm-live-1");
    expect(out.detail).toBe("sent via postmark");
    expect(seen).toEqual(["ws-live"]);
  });

  it("dryRunEspSender does no network and is deterministic", async () => {
    const a = await dryRunEspSender.send({ to: "x@y.com", subject: "s", body: "b" });
    const b = await dryRunEspSender.send({ to: "x@y.com", subject: "s", body: "b" });
    expect(a.externalId).toBe(b.externalId);
  });
});

describe("linkedin channel — permitted-API only, else queue (#280)", () => {
  const liMsg: ReachMessage = {
    contactKey: "linkedin:li/jane",
    channel: "linkedin",
    toAddress: "https://linkedin.com/in/jane",
    recipientLabel: "Jane · Acme",
    subject: "",
    body: "Hi Jane, worth a chat?",
    variant: "social_proof",
    signalKind: null,
  };

  it("QUEUES (never fakes/UI-automates) when no permitted send path is configured", async () => {
    const out = await createLinkedInChannel().send(liMsg, ctx());
    expect(out.status).toBe("queued");
    expect(out.externalId).toBeNull();
    expect(out.detail).toContain("never UI-automated");
  });

  it("sends through an official API when one is wired", async () => {
    const sender: LinkedInSender = { kind: "linkedin-api", async send() { return { externalId: "urn:li:1" }; } };
    const out = await createLinkedInChannel({ sender }).send(liMsg, ctx());
    expect(out.status).toBe("sent");
    expect(out.externalId).toBe("urn:li:1");
  });

  it("honours the opt-out list", async () => {
    const out = await createLinkedInChannel().send(liMsg, ctx({ suppressed: new Set(["https://linkedin.com/in/jane"]) }));
    expect(out.status).toBe("suppressed");
  });
});
