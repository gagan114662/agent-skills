import { describe, it, expect } from "vitest";
import {
  buildUsageRecord,
  isExternalReceipt,
  verifiedCostCents,
  type UsageRecord,
} from "../../src/provisioning/usage.js";

const NOW = 1_700_000_000_000;

describe("provisioning usage ledger (#200 §2 external-receipt grounding)", () => {
  it("a row is verified ONLY with a non-empty external receipt", () => {
    expect(isExternalReceipt("req_123")).toBe(true);
    expect(isExternalReceipt("  ")).toBe(false);
    expect(isExternalReceipt(null)).toBe(false);
    expect(isExternalReceipt(undefined)).toBe(false);
  });

  it("derives verified from the receipt — a caller cannot assert it true", () => {
    const grounded = buildUsageRecord(
      { workspaceId: "w", capabilityId: "serp_data", provider: "dataforseo", units: 3, costCents: 12, externalRef: "req_9" },
      NOW,
    );
    expect(grounded.verified).toBe(true);
    expect(grounded.externalRef).toBe("req_9");

    const estimate = buildUsageRecord(
      { workspaceId: "w", capabilityId: "serp_data", provider: "dataforseo", units: 3, costCents: 12, externalRef: "" },
      NOW,
    );
    expect(estimate.verified).toBe(false);
    expect(estimate.externalRef).toBeNull();
  });

  it("clamps negative/NaN units and cost to zero and stamps the injected time", () => {
    const r = buildUsageRecord(
      { workspaceId: "w", capabilityId: "keyword_data", provider: "mock", units: -5, costCents: Number.NaN },
      NOW,
    );
    expect(r.units).toBe(0);
    expect(r.costCents).toBe(0);
    expect(r.occurredAtMs).toBe(NOW);
  });

  it("billable total sums ONLY verified rows (estimates never drive a hard number)", () => {
    const rows: UsageRecord[] = [
      buildUsageRecord({ workspaceId: "w", capabilityId: "a", provider: "p", units: 1, costCents: 100, externalRef: "r1" }, NOW),
      buildUsageRecord({ workspaceId: "w", capabilityId: "b", provider: "p", units: 1, costCents: 999 }, NOW),
      buildUsageRecord({ workspaceId: "w", capabilityId: "c", provider: "p", units: 1, costCents: 50, externalRef: "r2" }, NOW),
    ];
    expect(verifiedCostCents(rows)).toBe(150);
  });
});
