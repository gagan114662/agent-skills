import { describe, it, expect } from "vitest";
import { computeMetrics, type SendDatum, type ReceiptDatum } from "../../../src/reach/measure.js";
import { tuneNextBatch, REACH_TUNING_DEFAULTS } from "../../../src/reach/self-tune.js";

function send(over: Partial<SendDatum> = {}): SendDatum {
  return { channel: "email", status: "sent", variant: "pain", signalKind: "funding_round", sentHourUtc: 15, ...over };
}
function receipt(over: Partial<ReceiptDatum> = {}): ReceiptDatum {
  return { kind: "reply", variant: "pain", signalKind: "funding_round", sentHourUtc: 15, ...over };
}

describe("computeMetrics (#280)", () => {
  it("tallies statuses and rates over delivered sends", () => {
    const sends = [
      send(),
      send({ status: "queued", channel: "linkedin" }),
      send({ status: "suppressed" }),
      send({ status: "rate_limited" }),
    ];
    const receipts = [receipt({ kind: "open" }), receipt({ kind: "reply" }), receipt({ kind: "booked" })];
    const m = computeMetrics({ prospectsFound: 10, sends, receipts });
    expect(m).toMatchObject({ contacted: 4, sent: 1, queued: 1, suppressed: 1, rateLimited: 1 });
    expect(m.opens).toBe(1);
    expect(m.replies).toBe(1);
    expect(m.booked).toBe(1);
    expect(m.replyRate).toBe(1); // 1 reply / 1 sent
  });

  it("breaks down by variant, signal kind, and hour", () => {
    const sends = [
      ...Array.from({ length: 10 }, () => send({ variant: "pain" })),
      ...Array.from({ length: 10 }, () => send({ variant: "outcome", sentHourUtc: 9 })),
    ];
    const receipts = [
      ...Array.from({ length: 4 }, () => receipt({ variant: "outcome", sentHourUtc: 9 })),
      receipt({ variant: "pain" }),
    ];
    const m = computeMetrics({ prospectsFound: 20, sends, receipts });
    const outcome = m.byVariant.find((v) => v.variant === "outcome")!;
    const pain = m.byVariant.find((v) => v.variant === "pain")!;
    expect(outcome.replyRate).toBeGreaterThan(pain.replyRate);
    expect(m.byVariant[0]?.variant).toBe("outcome"); // sorted by reply rate desc
    expect(m.byHour.find((h) => h.hourUtc === 9)?.replies).toBe(4);
  });
});

describe("tuneNextBatch (#280)", () => {
  it("switches the lead angle to the best-replying variant once it clears the sample floor", () => {
    const sends = [
      ...Array.from({ length: 12 }, () => send({ variant: "pain" })),
      ...Array.from({ length: 12 }, () => send({ variant: "outcome" })),
    ];
    const receipts = Array.from({ length: 6 }, () => receipt({ variant: "outcome" }));
    const m = computeMetrics({ prospectsFound: 24, sends, receipts });
    const report = tuneNextBatch(m, REACH_TUNING_DEFAULTS);
    expect(report.next.variant).toBe("outcome");
    expect(report.changes.some((c) => c.includes("lead angle"))).toBe(true);
  });

  it("holds when no cell clears the sample floor (a lucky reply can't swing it)", () => {
    const sends = [send({ variant: "outcome" })]; // only 1 sent
    const receipts = [receipt({ variant: "outcome" })];
    const m = computeMetrics({ prospectsFound: 1, sends, receipts });
    const report = tuneNextBatch(m, REACH_TUNING_DEFAULTS);
    expect(report.next.variant).toBe(REACH_TUNING_DEFAULTS.variant); // unchanged
  });

  it("promotes the best-replying signal kind to the front of the ICP priority", () => {
    const sends = [
      ...Array.from({ length: 12 }, () => send({ signalKind: "hiring_surge" })),
      ...Array.from({ length: 12 }, () => send({ signalKind: "funding_round" })),
    ];
    const receipts = Array.from({ length: 6 }, () => receipt({ signalKind: "hiring_surge" }));
    const m = computeMetrics({ prospectsFound: 24, sends, receipts });
    const report = tuneNextBatch(m, REACH_TUNING_DEFAULTS);
    expect(report.next.signalPriority[0]).toBe("hiring_surge");
  });

  it("moves the send hour to where replies land", () => {
    const sends = [
      ...Array.from({ length: 12 }, () => send({ sentHourUtc: 9 })),
      ...Array.from({ length: 12 }, () => send({ sentHourUtc: 18 })),
    ];
    const receipts = Array.from({ length: 6 }, () => receipt({ sentHourUtc: 18 }));
    const m = computeMetrics({ prospectsFound: 24, sends, receipts });
    const report = tuneNextBatch(m, { ...REACH_TUNING_DEFAULTS, sendHourUtc: 9 });
    expect(report.next.sendHourUtc).toBe(18);
  });
});
