import { describe, it, expect } from "vitest";
import {
  buildEspReadbackReceipt,
  buildLiveUrlReceipt,
  isExternalReceipt,
} from "../../src/outbound-channel/receipt.js";

const OBSERVED = "2026-06-21T12:00:00.000Z";

describe("outbound-channel readback receipts (#200 §3)", () => {
  it("builds a production_readback receipt from an ESP message id", () => {
    const r = buildEspReadbackReceipt({ messageId: "pm-abc-123", observedAt: OBSERVED });
    expect(r).not.toBeNull();
    expect(r?.source).toBe("production_readback");
    expect(r?.externalRef).toBe("pm-abc-123");
    expect(isExternalReceipt(r)).toBe(true);
  });

  it("carries optional structured detail", () => {
    const r = buildEspReadbackReceipt({
      messageId: "pm-1",
      observedAt: OBSERVED,
      detail: { stream: "broadcast" },
    });
    expect(r?.detail).toEqual({ stream: "broadcast" });
  });

  it("returns null for a blank message id or observed time (nothing to prove)", () => {
    expect(buildEspReadbackReceipt({ messageId: "", observedAt: OBSERVED })).toBeNull();
    expect(buildEspReadbackReceipt({ messageId: "  ", observedAt: OBSERVED })).toBeNull();
    expect(buildEspReadbackReceipt({ messageId: "pm-1", observedAt: "" })).toBeNull();
  });

  it("builds a live_url receipt only for a reachable status", () => {
    const ok = buildLiveUrlReceipt({ url: "https://x.test/u", httpStatus: 200, observedAt: OBSERVED });
    expect(ok).not.toBeNull();
    expect(isExternalReceipt(ok)).toBe(true);

    // A 5xx is not a live surface — the predicate rejects it, so the builder returns null.
    expect(buildLiveUrlReceipt({ url: "https://x.test/u", httpStatus: 503, observedAt: OBSERVED })).toBeNull();
  });

  it("a self-reported / fabricated receipt never passes isExternalReceipt", () => {
    expect(isExternalReceipt({ source: "agent_says_so", externalRef: "x", observedAt: OBSERVED })).toBe(false);
    expect(isExternalReceipt({ source: "production_readback", externalRef: "", observedAt: OBSERVED })).toBe(false);
    expect(isExternalReceipt(null)).toBe(false);
  });
});
