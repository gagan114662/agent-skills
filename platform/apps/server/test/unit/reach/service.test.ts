import { describe, it, expect } from "vitest";
import { ReachService, type ReachDeps } from "../../../src/reach/service.js";
import { createMockProspectSource } from "../../../src/reach/sources/mock.js";
import { createEmailChannel } from "../../../src/reach/channels/email.js";
import { createLinkedInChannel } from "../../../src/reach/channels/linkedin.js";
import { REACH_DEFAULTS, type ReachCaps } from "../../../src/reach/caps.js";
import type { ProspectSource } from "../../../src/reach/prospect-source.js";
import type { SendDatum, ReceiptDatum } from "../../../src/reach/measure.js";
import type { ReachTuningConfig } from "../../../src/reach/self-tune.js";

const NOW = new Date(Date.UTC(2026, 5, 16, 12, 0, 0));

interface SendRow extends SendDatum {
  id: string;
  contactKey: string;
  createdAt: Date;
}

/** Build the full set of in-memory store fakes the service writes through. */
function fakes() {
  const contacts = new Map<
    string,
    { status: string; currentStep: number; lastStepAtMs: number; recipientLabel: string; channel: "email" | "linkedin"; score: number; signalKind: string | null }
  >();
  const sends: SendRow[] = [];
  const receipts: (ReceiptDatum & { sendId: string; externalRef: string })[] = [];
  const runs: { status: string; tuning: ReachTuningConfig | null }[] = [];
  const approvalCalls: { provider: string; amountCents: number }[] = [];
  let sendSeq = 0;

  const deps: Omit<ReachDeps, "caps" | "resolveSource"> = {
    now: () => NOW,
    icp: { async seed() { return { domain: "ipop.ai", productKeywords: ["growth"], targetIndustries: ["saas"] }; } },
    channels: { email: createEmailChannel(), linkedin: createLinkedInChannel() },
    contacts: {
      async contactedKeys() {
        return new Set(contacts.keys());
      },
      async upsertEnrollment(input) {
        contacts.set(input.contactKey, {
          status: input.enrollment.status,
          currentStep: input.enrollment.currentStep,
          lastStepAtMs: input.enrollment.lastStepAtMs,
          recipientLabel: input.recipientLabel,
          channel: input.channel,
          score: input.score,
          signalKind: input.signalKind,
        });
      },
      async markStatus(_w, contactKey, status) {
        const c = contacts.get(contactKey);
        if (c) c.status = status;
      },
      async activeEnrollments() {
        return [...contacts.entries()]
          .filter(([, c]) => c.status === "active")
          .map(([contactKey, c]) => ({
            contactKey,
            recipientLabel: c.recipientLabel,
            channel: c.channel,
            currentStep: c.currentStep,
            lastStepAtMs: c.lastStepAtMs,
            score: c.score,
            signalKind: c.signalKind,
          }));
      },
    },
    sends: {
      async countSentSince(_w, since) {
        return sends.filter((s) => s.status === "sent" && s.createdAt >= since).length;
      },
      async insert(input) {
        const id = `send-${sendSeq++}`;
        sends.push({
          id,
          contactKey: input.contactKey,
          channel: input.channel,
          status: input.status,
          variant: input.variant,
          signalKind: input.signalKind as SendDatum["signalKind"],
          sentHourUtc: input.sentHourUtc,
          createdAt: NOW,
        });
        return { id };
      },
      async latestSendId(_w, contactKey) {
        const matching = sends.filter((s) => s.contactKey === contactKey);
        return matching.length ? matching[matching.length - 1]!.id : null;
      },
      async sendsSince(_w, since) {
        return sends.filter((s) => s.createdAt >= since).map((s) => ({
          channel: s.channel,
          status: s.status,
          variant: s.variant,
          signalKind: s.signalKind,
          sentHourUtc: s.sentHourUtc,
        }));
      },
    },
    receipts: {
      async record(input) {
        const dup = receipts.some(
          (r) => r.sendId === input.sendId && r.kind === input.kind && r.externalRef === input.externalRef,
        );
        if (dup) return { recorded: false };
        const send = sends.find((s) => s.id === input.sendId);
        receipts.push({
          sendId: input.sendId,
          externalRef: input.externalRef,
          kind: input.kind,
          variant: send?.variant ?? null,
          signalKind: send?.signalKind ?? null,
          sentHourUtc: send?.sentHourUtc ?? null,
        });
        return { recorded: true };
      },
      async receiptData() {
        return receipts.map((r) => ({ kind: r.kind, variant: r.variant, signalKind: r.signalKind, sentHourUtc: r.sentHourUtc }));
      },
    },
    runs: {
      async insert(input) {
        runs.push({ status: input.status, tuning: (input.tuningReport as { next?: ReachTuningConfig } | null)?.next ?? null });
        return { id: `run-${runs.length}` };
      },
      async latestTuning() {
        const completed = [...runs].reverse().find((r) => r.status === "completed");
        return completed?.tuning ?? null;
      },
    },
    suppressions: { async loadSuppressed() { return new Set<string>(); } },
    approvals: {
      async submitDataCreditSpend(input) {
        approvalCalls.push({ provider: input.provider, amountCents: input.amountCents });
        return { requestId: "req-1" };
      },
    },
  };
  return { deps, contacts, sends, receipts, runs, approvalCalls };
}

function caps(over: Partial<ReachCaps> = {}): ReachCaps {
  return {
    ...REACH_DEFAULTS,
    enabled: true,
    brandName: "ipop",
    postalAddress: "1 Market St, SF",
    unsubscribeUrl: "https://ipop.ai/u",
    ...over,
  };
}

const mockSource: ReachDeps["resolveSource"] = () => createMockProspectSource({ now: () => NOW.getTime() });

describe("ReachService.runBatch (#280)", () => {
  it("runs the loop end-to-end: sources, sends (dry-run), enrols, measures, self-tunes", async () => {
    const f = fakes();
    const svc = new ReachService({ ...f.deps, caps: () => caps({ batchSize: 5 }), resolveSource: mockSource });
    const res = await svc.runBatch("ws1");
    expect(res.status).toBe("completed");
    expect(res.prospectsFound).toBe(5);
    expect(res.messagesSent).toBe(5);
    expect(f.contacts.size).toBe(5); // all enrolled
    expect(f.sends.filter((s) => s.status === "sent")).toHaveLength(5);
    expect(res.tuning).not.toBeNull();
  });

  it("dedupes against already-contacted on the next run (never re-touches the list)", async () => {
    const f = fakes();
    const svc = new ReachService({ ...f.deps, caps: () => caps({ batchSize: 5 }), resolveSource: mockSource });
    await svc.runBatch("ws1");
    const firstKeys = new Set(f.contacts.keys());
    await svc.runBatch("ws1");
    // second batch enrolled 5 MORE distinct prospects (none repeated)
    expect(f.contacts.size).toBe(10);
    const secondKeys = [...f.contacts.keys()].filter((k) => !firstKeys.has(k));
    expect(secondKeys).toHaveLength(5);
  });

  it("fires DUE cadence follow-ups on a later run (the multi-step cadence actually advances)", async () => {
    const f = fakes();
    let clock = NOW.getTime();
    const svc = new ReachService({
      ...f.deps,
      now: () => new Date(clock),
      caps: () => caps({ batchSize: 3, perDomainDailyCap: 100 }),
      resolveSource: mockSource,
    });
    await svc.runBatch("ws1"); // 3 enrolled at step 1 (opener sent)
    const enrolled = [...f.contacts.keys()];
    expect(enrolled).toHaveLength(3);
    for (const k of enrolled) expect(f.contacts.get(k)?.currentStep).toBe(1);

    clock = NOW.getTime() + 4 * 24 * 60 * 60 * 1000; // +4 days → step 1 (wait 3d) is now due
    await svc.runBatch("ws1");
    // the original three advanced to step 2 — a follow-up touch fired for each
    for (const k of enrolled) expect(f.contacts.get(k)?.currentStep).toBe(2);
    // follow-ups carry the step-1 angle ("outcome") and the follow-up subject
    expect(f.sends.some((s) => s.contactKey === enrolled[0] && s.variant === "outcome")).toBe(true);
  });

  it("enforces the per-domain daily cap (excess prospects are rate_limited, not sent)", async () => {
    const f = fakes();
    const svc = new ReachService({
      ...f.deps,
      caps: () => caps({ batchSize: 5, perDomainDailyCap: 2 }),
      resolveSource: mockSource,
    });
    const res = await svc.runBatch("ws1");
    expect(res.messagesSent).toBe(2);
    expect(res.rateLimited).toBe(3);
  });

  it("honours suppression / opt-out (the recipient is dropped)", async () => {
    const f = fakes();
    // suppress the first mock prospect's email
    const probe = createMockProspectSource({ now: () => NOW.getTime() });
    const { prospects } = await probe.search({
      icp: { domain: "ipop.ai", industries: ["saas"], roles: ["head of growth"], companySizes: [], keywords: ["growth"], signalKinds: ["funding_round"] },
      limit: 1,
      excludeKeys: new Set(),
    });
    const suppressedEmail = prospects[0]!.email!.toLowerCase();
    const svc = new ReachService({
      ...f.deps,
      suppressions: { async loadSuppressed() { return new Set([suppressedEmail]); } },
      caps: () => caps({ batchSize: 3 }),
      resolveSource: mockSource,
    });
    const res = await svc.runBatch("ws1");
    expect(res.suppressed).toBeGreaterThanOrEqual(1);
    expect(f.sends.some((s) => s.status === "suppressed")).toBe(true);
  });

  it("skips every send when the CAN-SPAM footer facts are incomplete (no unlawful send)", async () => {
    const f = fakes();
    const svc = new ReachService({
      ...f.deps,
      caps: () => caps({ batchSize: 3, postalAddress: null, unsubscribeUrl: null }),
      resolveSource: mockSource,
    });
    const res = await svc.runBatch("ws1");
    expect(res.messagesSent).toBe(0);
    expect(f.sends.every((s) => s.status === "skipped")).toBe(true);
  });

  it("MONEY-GATES a paid prospect source: parks an approval, spends/sends nothing", async () => {
    const f = fakes();
    const paid: ProspectSource = {
      kind: "clay",
      paid: true,
      estimateCostCents: (limit) => limit * 5,
      async search() {
        throw new Error("must not be called before approval");
      },
    };
    const svc = new ReachService({
      ...f.deps,
      caps: () => caps({ batchSize: 10, prospectSource: "clay" }),
      resolveSource: () => paid,
    });
    const res = await svc.runBatch("ws1");
    expect(res.status).toBe("awaiting_data_funding");
    expect(res.approvalRequestId).toBe("req-1");
    expect(f.approvalCalls).toEqual([{ provider: "clay", amountCents: 50 }]);
    expect(f.sends).toHaveLength(0); // nothing sent
  });

  it("records a skipped run (and sends nothing) when disabled", async () => {
    const f = fakes();
    const svc = new ReachService({ ...f.deps, caps: () => caps({ enabled: false }), resolveSource: mockSource });
    const res = await svc.runBatch("ws1");
    expect(res.status).toBe("skipped");
    expect(f.sends).toHaveLength(0);
    expect(f.runs[0]?.status).toBe("skipped");
  });
});

describe("ReachService.recordReceipt (#280)", () => {
  it("records an external receipt idempotently and stops the cadence on a reply", async () => {
    const f = fakes();
    const svc = new ReachService({ ...f.deps, caps: () => caps({ batchSize: 1 }), resolveSource: mockSource });
    await svc.runBatch("ws1");
    const contactKey = [...f.contacts.keys()][0]!;

    const first = await svc.recordReceipt("ws1", { contactKey, kind: "reply", externalRef: "evt-1" });
    expect(first.recorded).toBe(true);
    expect(f.contacts.get(contactKey)?.status).toBe("replied"); // cadence stopped

    const dup = await svc.recordReceipt("ws1", { contactKey, kind: "reply", externalRef: "evt-1" });
    expect(dup.recorded).toBe(false); // idempotent

    const noRef = await svc.recordReceipt("ws1", { contactKey, kind: "open", externalRef: "  " });
    expect(noRef.recorded).toBe(false); // external proof required
  });
});
