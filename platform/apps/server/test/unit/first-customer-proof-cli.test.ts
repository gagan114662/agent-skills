import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatFirstCustomerProofReport,
  loadFirstCustomerProofJson,
  parseFirstCustomerProofCliConfig,
} from "../../src/first-customer/proof-cli.js";
import type { FirstCustomerProof } from "../../src/first-customer/proof.js";

const proof: FirstCustomerProof = {
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

let tempDir = "";

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("first-customer proof CLI (#908)", () => {
  it("parses --file and -f", () => {
    expect(parseFirstCustomerProofCliConfig(["--file", "proof.json"])).toEqual({
      file: "proof.json",
    });
    expect(parseFirstCustomerProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "first-customer-proof-"));
    const file = join(tempDir, "proof.json");
    await writeFile(file, JSON.stringify(proof), "utf8");

    await expect(loadFirstCustomerProofJson({ file })).resolves.toMatchObject({
      prospectSource: { sampleEmails: ["founder@real-startup.co"] },
    });
  });

  it("prints a pass report for complete proof", () => {
    expect(formatFirstCustomerProofReport(proof)).toEqual([
      "PASS first-customer-proof: full source -> send -> reply -> route -> booking spine proven",
    ]);
  });

  it("prints requirement-level gaps for incomplete proof", () => {
    const lines = formatFirstCustomerProofReport({
      ...proof,
      prospectSource: {
        ...proof.prospectSource,
        trackingRef: "",
        fabricatedCount: 1,
        sampleEmails: ["buyer@example.test"],
      },
      outboundDelivery: {
        ...proof.outboundDelivery,
        provider: "dryrun",
        approvalRequestId: "",
        trackingRef: "ipop_other",
        receipt: {
          source: "agent_says_so",
          externalRef: "sent",
          observedAt: "2026-06-26T04:30:00.000Z",
        },
      },
      reply: { ...proof.reply, replyFrom: "other@real-company.co", visibleInInbox: false },
      inboundRoute: { ...proof.inboundRoute, trackingRef: "ipop_other" },
      booking: { ...proof.booking, url: "https://cal.com/ipop/intro", trackingRef: "ipop_other" },
    });

    expect(lines[0]).toBe("FAIL first-customer-proof: 12 gap(s)");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("real_prospect_source"),
        expect.stringContaining("real_outbound_delivery"),
        expect.stringContaining("reply_ingested_visible"),
        expect.stringContaining("booking_or_trial_link"),
      ]),
    );
  });
});
