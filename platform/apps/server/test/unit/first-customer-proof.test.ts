import { describe, expect, it } from "vitest";
import {
  verifyFirstCustomerProof,
  type FirstCustomerProof,
} from "../../src/first-customer/proof.js";

const baseProof: FirstCustomerProof = {
  prospectSource: {
    kind: "csv_import",
    importedCount: 1,
    fabricatedCount: 0,
    trackingRef: "ipop_deadbeefdeadbeef",
    sampleEmails: ["founder@real-startup.co"],
  },
  outboundDelivery: {
    channel: "email_postmark",
    provider: "postmark",
    recipient: "founder@real-startup.co",
    approvalRequestId: "approval_123",
    trackingRef: "ipop_deadbeefdeadbeef",
    receipt: {
      source: "production_readback",
      externalRef: "pm-message-id-123",
      observedAt: "2026-06-26T04:30:00.000Z",
      detail: { provider: "postmark" },
    },
  },
  reply: {
    providerThreadId: "thread_pm_123",
    replyMessageId: "reply_pm_123",
    replyFrom: "founder@real-startup.co",
    visibleInLeadTimeline: true,
    visibleInInbox: true,
  },
  inboundRoute: {
    leadId: "lead_123",
    leadEmail: "founder@real-startup.co",
    rule: "inbound_lead",
    trackingRef: "ipop_deadbeefdeadbeef",
    autoQualified: true,
    acknowledged: true,
    routedToCadence: true,
  },
  booking: {
    url: "https://cal.com/ipop/intro?ref=ipop_deadbeefdeadbeef",
    surface: "outreach_cta",
    trackingRef: "ipop_deadbeefdeadbeef",
  },
};

describe("verifyFirstCustomerProof (#908 / #395 close gate)", () => {
  it("passes only when the full first-customer spine has real external proof", () => {
    const result = verifyFirstCustomerProof(baseProof);
    expect(result.proven).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("also accepts Resend as a real email ESP channel when the provider and channel match", () => {
    const result = verifyFirstCustomerProof({
      ...baseProof,
      outboundDelivery: {
        ...baseProof.outboundDelivery,
        channel: "email_resend",
        provider: "resend",
        receipt: {
          ...baseProof.outboundDelivery.receipt,
          externalRef: "resend-email-id-123",
          detail: { provider: "resend" },
        },
      },
    });

    expect(result.proven).toBe(true);
  });

  it("rejects mock prospects, dry-run delivery, missing approval, invisible replies, unrouted leads, and no booking link", () => {
    const result = verifyFirstCustomerProof({
      prospectSource: {
        kind: "csv_import",
        importedCount: 1,
        fabricatedCount: 3,
        trackingRef: "",
        sampleEmails: ["buyer@example.test"],
      },
      outboundDelivery: {
        channel: "email_postmark",
        provider: "dryrun",
        recipient: "other@real-company.co",
        approvalRequestId: "",
        trackingRef: "ipop_other",
        receipt: {
          source: "live_url",
          externalRef: "https://ipop.ai/blog/dryrun",
          httpStatus: 200,
          observedAt: "2026-06-26T04:30:00.000Z",
        },
      },
      reply: {
        providerThreadId: "",
        replyMessageId: "",
        replyFrom: "someone-else@real-company.co",
        visibleInLeadTimeline: false,
        visibleInInbox: false,
      },
      inboundRoute: {
        leadId: "",
        leadEmail: "someone-else@real-company.co",
        rule: "inbound_lead",
        trackingRef: "ipop_other",
        autoQualified: false,
        acknowledged: false,
        routedToCadence: false,
      },
      booking: {
        url: "https://cal.com/ipop/intro",
        surface: "landing_form",
        trackingRef: "ipop_other",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps.map((g) => g.requirement)).toEqual([
      "real_prospect_source",
      "real_prospect_source",
      "real_prospect_source",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "reply_ingested_visible",
      "reply_ingested_visible",
      "reply_ingested_visible",
      "inbound_qualified_routed",
      "inbound_qualified_routed",
      "inbound_qualified_routed",
      "inbound_qualified_routed",
      "booking_or_trial_link",
    ]);
  });

  it("rejects a mismatched ESP provider/channel pair", () => {
    const result = verifyFirstCustomerProof({
      ...baseProof,
      outboundDelivery: {
        ...baseProof.outboundDelivery,
        channel: "email_resend",
        provider: "postmark",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        requirement: "real_outbound_delivery",
        message: expect.stringContaining("real email ESP channel"),
      }),
    );
  });

  it("rejects a Frankenstein proof where valid stages belong to different buyers", () => {
    const result = verifyFirstCustomerProof({
      ...baseProof,
      outboundDelivery: {
        ...baseProof.outboundDelivery,
        recipient: "finance@other-buyer.co",
      },
      reply: {
        ...baseProof.reply,
        replyFrom: "ops@another-buyer.co",
      },
      inboundRoute: {
        ...baseProof.inboundRoute,
        leadEmail: "founder@real-startup.co",
        trackingRef: "ipop_otherref",
      },
      booking: {
        ...baseProof.booking,
        url: "https://cal.com/ipop/intro?ref=ipop_otherref",
        trackingRef: "ipop_otherref",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirement: "real_outbound_delivery" }),
        expect.objectContaining({ requirement: "reply_ingested_visible" }),
        expect.objectContaining({ requirement: "inbound_qualified_routed" }),
        expect.objectContaining({ requirement: "booking_or_trial_link" }),
      ]),
    );
  });
});
