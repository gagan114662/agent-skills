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
        fabricatedCount: 1,
        sampleEmails: ["buyer@example.test"],
      },
      outboundDelivery: {
        ...proof.outboundDelivery,
        provider: "dryrun",
        approvalRequestId: "",
        receipt: {
          source: "agent_says_so",
          externalRef: "sent",
          observedAt: "2026-06-26T04:30:00.000Z",
        },
      },
      reply: { ...proof.reply, visibleInInbox: false },
      booking: { ...proof.booking, url: "" },
    });

    expect(lines[0]).toBe("FAIL first-customer-proof: 7 gap(s)");
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
