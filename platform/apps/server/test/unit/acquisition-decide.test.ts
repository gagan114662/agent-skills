import { describe, it, expect } from "vitest";
import {
  ACQUISITION_CHANNELS,
  ACQUISITION_SEND_KINDS,
  channelForKind,
  isAcquisitionSendKind,
  reversibilityForChannel,
  decideSpendWithinEnvelope,
  decideSendGate,
  applyQuarantine,
  isTrustedProvenance,
  decideRetry,
  type BudgetEnvelope,
  type SendGateInput,
} from "../../src/acquisition/decide.js";

describe("channelForKind", () => {
  it("maps every send kind to a channel", () => {
    for (const kind of ACQUISITION_SEND_KINDS) {
      expect(ACQUISITION_CHANNELS).toContain(channelForKind(kind));
    }
  });
  it("maps the four kinds to their channels", () => {
    expect(channelForKind("ad.spend")).toBe("ads");
    expect(channelForKind("email.send")).toBe("email");
    expect(channelForKind("social.post")).toBe("social");
    expect(channelForKind("content.publish")).toBe("seo");
  });
  it("returns null for a kind this module does not own", () => {
    expect(channelForKind("support.reply")).toBeNull();
    expect(channelForKind("chat.post_message")).toBeNull();
  });
  it("isAcquisitionSendKind is a precise guard", () => {
    expect(isAcquisitionSendKind("email.send")).toBe(true);
    expect(isAcquisitionSendKind("support.reply")).toBe(false);
  });
});

describe("reversibilityForChannel", () => {
  it("treats ads/email/social as irreversible and seo as reversible (premortem #200 §4)", () => {
    expect(reversibilityForChannel("ads")).toBe("irreversible");
    expect(reversibilityForChannel("email")).toBe("irreversible");
    expect(reversibilityForChannel("social")).toBe("irreversible");
    expect(reversibilityForChannel("seo")).toBe("reversible");
  });
  it("has a class for every channel", () => {
    for (const c of ACQUISITION_CHANNELS) {
      expect(["reversible", "cheap", "irreversible"]).toContain(reversibilityForChannel(c));
    }
  });
});

describe("decideSpendWithinEnvelope (AC1: the envelope is the money decision)", () => {
  const active = (cap: number, spent: number): BudgetEnvelope => ({
    capCents: cap,
    spentCents: spent,
    status: "active",
  });

  it("allows an optimization that fits inside an active envelope — autonomously", () => {
    const d = decideSpendWithinEnvelope(active(10_000, 4_000), 2_000);
    expect(d.allowed).toBe(true);
    expect(d.requiresOwner).toBe(false);
    expect(d.remainingCents).toBe(6_000);
  });

  it("allows spending exactly to the cap", () => {
    const d = decideSpendWithinEnvelope(active(10_000, 8_000), 2_000);
    expect(d.allowed).toBe(true);
    expect(d.requiresOwner).toBe(false);
  });

  it("requires the owner for a spend over the remaining envelope", () => {
    const d = decideSpendWithinEnvelope(active(10_000, 9_000), 2_000);
    expect(d.allowed).toBe(false);
    expect(d.requiresOwner).toBe(true);
    expect(d.remainingCents).toBe(1_000);
  });

  it("requires the owner when there is no active envelope", () => {
    for (const status of ["pending", "exhausted", "paused", "revoked"] as const) {
      const d = decideSpendWithinEnvelope({ capCents: 10_000, spentCents: 0, status }, 100);
      expect(d.allowed).toBe(false);
      expect(d.requiresOwner).toBe(true);
    }
  });

  it("a non-positive request is a no-op (spends nothing, no owner needed)", () => {
    expect(decideSpendWithinEnvelope(active(10_000, 0), 0).allowed).toBe(true);
    expect(decideSpendWithinEnvelope(active(10_000, 0), -5).allowed).toBe(true);
    expect(decideSpendWithinEnvelope(active(10_000, 0), -5).requiresOwner).toBe(false);
  });

  it("never reports negative remaining", () => {
    expect(decideSpendWithinEnvelope(active(10_000, 12_000), 1).remainingCents).toBe(0);
  });
});

describe("decideSendGate (AC2: earn auto-send within caps)", () => {
  const base: SendGateInput = {
    channel: "email",
    channelEnabled: true,
    providerConnected: true,
    ownerWorkspace: true,
    autoSendEnabled: true,
    earnedAutoSend: true,
    sentInWindow: 0,
    windowCap: 100,
    provenance: "agent",
  };

  it("promotes to auto only when every earn-condition holds", () => {
    expect(decideSendGate(base).gate).toBe("auto");
  });

  it("defaults to approval — the sensitive-by-default human gate", () => {
    expect(decideSendGate({ ...base, autoSendEnabled: false }).gate).toBe("approval");
    expect(decideSendGate({ ...base, earnedAutoSend: false }).gate).toBe("approval");
    expect(decideSendGate({ ...base, ownerWorkspace: false }).gate).toBe("approval");
  });

  it("blocks when the channel is disabled", () => {
    expect(decideSendGate({ ...base, channelEnabled: false }).gate).toBe("blocked");
  });

  it("requires owner approval when the provider is not connected (no silent skip)", () => {
    const d = decideSendGate({ ...base, providerConnected: false });
    expect(d.gate).toBe("approval");
    expect(d.reason).toContain("connect");
  });

  it("blocks (never silently spams) once the window cap is reached", () => {
    expect(decideSendGate({ ...base, sentInWindow: 100, windowCap: 100 }).gate).toBe("blocked");
    expect(decideSendGate({ ...base, windowCap: 0 }).gate).toBe("blocked");
  });

  it("forces a human when provenance is web-read or mixed (premortem #200 §6)", () => {
    expect(decideSendGate({ ...base, provenance: "web_read" }).gate).toBe("approval");
    expect(decideSendGate({ ...base, provenance: "mixed" }).gate).toBe("approval");
  });
});

describe("applyQuarantine (premortem #200 §6 latch)", () => {
  it("downgrades an auto gate to approval for untrusted provenance", () => {
    const d = applyQuarantine("auto", "web_read");
    expect(d.gate).toBe("approval");
    expect(d.quarantined).toBe(true);
  });
  it("leaves auto alone for trusted provenance", () => {
    expect(applyQuarantine("auto", "human").gate).toBe("auto");
    expect(applyQuarantine("auto", "agent").quarantined).toBe(false);
  });
  it("passes approval and blocked through unchanged", () => {
    expect(applyQuarantine("approval", "web_read").gate).toBe("approval");
    expect(applyQuarantine("blocked", "web_read").gate).toBe("blocked");
  });
  it("isTrustedProvenance is exhaustive", () => {
    expect(isTrustedProvenance("human")).toBe(true);
    expect(isTrustedProvenance("agent")).toBe(true);
    expect(isTrustedProvenance("web_read")).toBe(false);
    expect(isTrustedProvenance("mixed")).toBe(false);
  });
});

describe("decideRetry (AC3: social failures retry + surface)", () => {
  it("retries a transient failure with growing backoff", () => {
    const d1 = decideRetry(1, 3, "transient");
    expect(d1.retry).toBe(true);
    expect(d1.nextAttempt).toBe(2);
    expect(d1.surfaceToBrief).toBe(false);
    const d2 = decideRetry(2, 3, "transient");
    expect(d2.retry).toBe(true);
    expect(d2.delayMs).toBeGreaterThan(d1.delayMs);
  });
  it("never retries a permanent failure and surfaces it", () => {
    const d = decideRetry(1, 5, "permanent");
    expect(d.retry).toBe(false);
    expect(d.surfaceToBrief).toBe(true);
  });
  it("surfaces a transient failure once retries are exhausted", () => {
    const d = decideRetry(3, 3, "transient");
    expect(d.retry).toBe(false);
    expect(d.surfaceToBrief).toBe(true);
  });
});
