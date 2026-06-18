import { describe, it, expect } from "vitest";
import {
  buildUsageReceipt,
  sanitizeProviderText,
  aggregateByAgent,
  aggregateByCustomer,
  verifiedCostCents,
  type UsageMeasurement,
  type UsageReceipt,
} from "../../src/enterprise/metering.js";

const NOW = 1_700_000_000_000;
// A control character without a literal control byte in this source file (the editor mangles literal control
// chars). hasControlChar scans by char code so the test needs no control-char regex (eslint no-control-regex).
const CTRL = String.fromCharCode(7); // BEL
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function measure(over: Partial<UsageMeasurement> = {}): UsageMeasurement {
  return {
    workspaceId: "ws_1",
    agentId: "bid",
    kind: "model",
    resource: "claude-opus-4-8",
    units: 1,
    costCents: 100,
    externalRef: "anthropic_req_abc",
    provider: "anthropic",
    ...over,
  };
}

describe("enterprise metering — verifiable receipts (#200 §2)", () => {
  it("derives verified=true + provenance=external ONLY from a non-empty external receipt", () => {
    const r = buildUsageReceipt(measure({ externalRef: "stripe_evt_9" }), NOW);
    expect(r.verified).toBe(true);
    expect(r.provenance).toBe("external");
    expect(r.externalRef).toBe("stripe_evt_9");
  });

  it("a blank / whitespace / missing receipt is an UNVERIFIED internal estimate", () => {
    for (const ref of [undefined, null, "", "   ", "\t\n"]) {
      const r = buildUsageReceipt(measure({ externalRef: ref }), NOW);
      expect(r.verified).toBe(false);
      expect(r.provenance).toBe("internal_estimate");
      expect(r.externalRef).toBeNull();
    }
  });

  it("the receipt id is deterministic for the same measurement (a stable provenance handle)", () => {
    const a = buildUsageReceipt(measure(), NOW);
    const b = buildUsageReceipt(measure(), NOW);
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.receiptId.length).toBeGreaterThan(0);
  });

  it("different external receipts produce different receipt ids", () => {
    const a = buildUsageReceipt(measure({ externalRef: "ref_a" }), NOW);
    const b = buildUsageReceipt(measure({ externalRef: "ref_b" }), NOW);
    expect(a.receiptId).not.toBe(b.receiptId);
  });

  it("carries the per-agent + per-customer dimensions", () => {
    const r = buildUsageReceipt(measure({ workspaceId: "ws_42", agentId: "lens" }), NOW);
    expect(r.workspaceId).toBe("ws_42");
    expect(r.agentId).toBe("lens");
    expect(r.occurredAtMs).toBe(NOW);
  });
});

describe("enterprise metering — injection defense (#200 §6, untrusted provider input)", () => {
  it("never lets a caller assert verification — verified is DERIVED, not an input field", () => {
    // The measurement type has no `verified` field; a forged one is ignored by the shaper.
    const forged = { ...measure({ externalRef: "" }), verified: true } as unknown as UsageMeasurement;
    const r = buildUsageReceipt(forged, NOW);
    expect(r.verified).toBe(false);
  });

  it("clamps a negative / NaN / Infinity cost and units to 0 (a poisoned number can't go negative)", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = buildUsageReceipt(measure({ costCents: bad, units: bad }), NOW);
      expect(r.costCents).toBe(0);
      expect(r.units).toBe(0);
    }
  });

  it("strips control characters and caps length on provider-supplied free text", () => {
    const dirty = `anthropic ${CTRL}<script>` + "x".repeat(500);
    const cleaned = sanitizeProviderText(dirty, 64);
    expect(hasControlChar(cleaned)).toBe(false);
    expect(cleaned.length).toBeLessThanOrEqual(64);
  });

  it("sanitizes resource + provider on the persisted receipt", () => {
    const r = buildUsageReceipt(measure({ resource: `gpt${CTRL}4`, provider: `open${CTRL}ai` }), NOW);
    expect(hasControlChar(r.resource)).toBe(false);
    expect(hasControlChar(r.provider ?? "")).toBe(false);
  });
});

describe("enterprise metering — aggregation per agent + per customer", () => {
  const receipts: UsageReceipt[] = [
    buildUsageReceipt(measure({ agentId: "bid", costCents: 100, units: 2, externalRef: "r1" }), NOW),
    buildUsageReceipt(measure({ agentId: "bid", costCents: 50, units: 1, externalRef: "" }), NOW),
    buildUsageReceipt(measure({ agentId: "lens", costCents: 200, units: 3, externalRef: "r3" }), NOW),
  ];

  it("verifiedCostCents sums ONLY externally-grounded rows", () => {
    expect(verifiedCostCents(receipts)).toBe(300); // 100 + 200; the 50 unverified row excluded
  });

  it("aggregateByAgent splits totals + verified totals per agent", () => {
    const byAgent = aggregateByAgent(receipts);
    const bid = byAgent.find((a) => a.agentId === "bid");
    const lens = byAgent.find((a) => a.agentId === "lens");
    expect(bid).toMatchObject({ totalCostCents: 150, verifiedCostCents: 100, eventCount: 2 });
    expect(lens).toMatchObject({ totalCostCents: 200, verifiedCostCents: 200, eventCount: 1 });
  });

  it("aggregateByCustomer rolls a workspace's usage with the verified share", () => {
    const c = aggregateByCustomer(receipts, "ws_1");
    expect(c.workspaceId).toBe("ws_1");
    expect(c.totalCostCents).toBe(350);
    expect(c.verifiedCostCents).toBe(300);
    expect(c.eventCount).toBe(3);
  });
});
