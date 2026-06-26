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
    sampleEmails: ["founder@real-startup.co"],
  },
  outboundDelivery: {
    channel: "email_postmark",
    provider: "postmark",
    recipient: "founder@real-startup.co",
    approvalRequestId: "approval_123",
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
    visibleInLeadTimeline: true,
    visibleInInbox: true,
  },
  inboundRoute: {
    leadId: "lead_123",
    rule: "inbound_lead",
    autoQualified: true,
    acknowledged: true,
    routedToCadence: true,
  },
  booking: {
    url: "https://cal.com/ipop/intro",
    surface: "outreach_cta",
  },
};

describe("verifyFirstCustomerProof (#908 / #395 close gate)", () => {
  it("passes only when the full first-customer spine has real external proof", () => {
    const result = verifyFirstCustomerProof(baseProof);
    expect(result.proven).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("rejects mock prospects, dry-run delivery, missing approval, invisible replies, unrouted leads, and no booking link", () => {
    const result = verifyFirstCustomerProof({
      prospectSource: {
        kind: "csv_import",
        importedCount: 1,
        fabricatedCount: 3,
        sampleEmails: ["buyer@example.test"],
      },
      outboundDelivery: {
        channel: "email_postmark",
        provider: "dryrun",
        recipient: "buyer@example.test",
        approvalRequestId: "",
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
        visibleInLeadTimeline: false,
        visibleInInbox: false,
      },
      inboundRoute: {
        leadId: "",
        rule: "inbound_lead",
        autoQualified: false,
        acknowledged: false,
        routedToCadence: false,
      },
      booking: {
        url: "",
        surface: "landing_form",
      },
    });

    expect(result.proven).toBe(false);
    expect(result.gaps.map((g) => g.requirement)).toEqual([
      "real_prospect_source",
      "real_prospect_source",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "real_outbound_delivery",
      "reply_ingested_visible",
      "reply_ingested_visible",
      "inbound_qualified_routed",
      "inbound_qualified_routed",
      "booking_or_trial_link",
    ]);
  });
});
