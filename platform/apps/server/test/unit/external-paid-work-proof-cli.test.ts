import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  formatExternalPaidWorkProofReport,
  loadExternalPaidWorkProofJson,
  parseExternalPaidWorkProofCliConfig,
  type ExternalPaidWorkProofCliConfig,
} from "../../src/founder-work/proof-cli.js";
import type { ExternalPaidWorkProof } from "../../src/founder-work/proof.js";

const completeProof: ExternalPaidWorkProof = {
  opportunity: {
    source: "public_bounty",
    sourceUrl: "https://bounties.example.org/jobs/growth-page",
    customerRef: "customer_acme",
    valueCents: 50_000,
    currency: "usd",
    externallySourced: true,
    selfMarketing: false,
  },
  deliverable: {
    kind: "landing_page",
    deliverableRef: "deliverable_123",
    verificationPassed: true,
    verificationReceipt: {
      source: "live_url",
      externalRef: "https://customer.example.org/growth-page",
      httpStatus: 200,
      observedAt: "2026-06-28T02:00:00.000Z",
    },
  },
  delivery: {
    approvalRequestId: "approval_13_123",
    receipt: {
      source: "production_readback",
      externalRef: "client-delivery-thread-123",
      observedAt: "2026-06-28T02:05:00.000Z",
      detail: { provider: "gmail" },
    },
  },
  payment: {
    provider: "stripe",
    providerEventId: "evt_external_paid_work_123",
    amountCents: 50_000,
    currency: "usd",
    customerRef: "customer_acme",
    receipt: {
      source: "production_readback",
      externalRef: "evt_external_paid_work_123",
      observedAt: "2026-06-28T02:30:00.000Z",
      detail: { provider: "stripe" },
    },
  },
};

describe("external-paid-work proof CLI (#387)", () => {
  it("parses --file and -f", () => {
    expect(parseExternalPaidWorkProofCliConfig(["--file", "proof.json"])).toEqual({ file: "proof.json" });
    expect(parseExternalPaidWorkProofCliConfig(["-f=proof.json"])).toEqual({ file: "proof.json" });
  });

  it("loads proof JSON from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "external-paid-work-proof-"));
    const file = join(dir, "proof.json");
    await writeFile(file, JSON.stringify(completeProof), "utf8");

    await expect(loadExternalPaidWorkProofJson({ file })).resolves.toMatchObject({
      opportunity: { customerRef: "customer_acme" },
      payment: { providerEventId: "evt_external_paid_work_123" },
    });
  });

  it("formats a passing proof report", () => {
    expect(formatExternalPaidWorkProofReport(completeProof)).toEqual([
      "PASS external-paid-work-proof: external opportunity -> verified delivery -> provider payment proven",
    ]);
  });

  it("fails closed with actionable gaps for self-marketing and fake payment evidence", () => {
    const lines = formatExternalPaidWorkProofReport({
      ...completeProof,
      opportunity: {
        ...completeProof.opportunity,
        source: "self_marketing",
        sourceUrl: "https://ipop.ai/",
        valueCents: 0,
        externallySourced: false,
        selfMarketing: true,
      },
      payment: {
        ...completeProof.payment,
        provider: "manual_claim",
        providerEventId: "",
        amountCents: 0,
        customerRef: "someone_else",
      },
    });

    expect(lines[0]).toBe("FAIL external-paid-work-proof: 5 gap(s)");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FAIL external_opportunity:"),
        expect.stringContaining("FAIL external_payment:"),
      ]),
    );
  });

  it("requires a proof JSON body", async () => {
    const readStdin = async () => "   ";
    await expect(
      loadExternalPaidWorkProofJson({ file: "", readStdin } as ExternalPaidWorkProofCliConfig),
    ).rejects.toThrow("external-paid-work proof JSON is required");
  });
});
