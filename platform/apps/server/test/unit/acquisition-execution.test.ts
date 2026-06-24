import { describe, it, expect } from "vitest";
import {
  createAcquisitionDispatcher,
  type SendReceiptInput,
  type AcquisitionDispatcherDeps,
} from "../../src/acquisition/execution.js";
import {
  createAcquisitionProviders,
  dryRunAdsProvider,
  dryRunEspProvider,
  type SendOutcome,
} from "../../src/acquisition/providers.js";
import { resolveAcquisitionCaps, type AcquisitionCaps } from "../../src/acquisition/caps.js";
import { appendComplianceFooter, type FooterInfo } from "../../src/acquisition/compliance.js";
import { ActionExecutionError } from "../../src/approvals/executor.js";
import type { BudgetEnvelope } from "../../src/acquisition/decide.js";

const WS = "ws-1";
const footer: FooterInfo = {
  brandName: "Acme",
  postalAddress: "1 Main St",
  unsubscribeUrl: "https://acme.test/u",
};

function harness(opts: {
  caps: AcquisitionCaps;
  envelope?: BudgetEnvelope | null;
  suppressed?: Set<string>;
  warmup?: { dayIndex: number; sentToday: number };
  footer?: FooterInfo | null;
  providers?: Parameters<typeof createAcquisitionProviders>[1];
  loadInactiveEnvelope?: boolean;
}) {
  const receipts: SendReceiptInput[] = [];
  let envelope = opts.envelope ? { ...opts.envelope } : null;
  let reservedCents = 0;
  const activeEnvelope = () =>
    opts.loadInactiveEnvelope || envelope?.status === "active" ? (envelope ? { ...envelope } : null) : null;
  async function reserve(amount: number): Promise<BudgetEnvelope | null> {
    if (!envelope || envelope.status !== "active") return null;
    if (amount > Math.max(0, envelope.capCents - envelope.spentCents)) return null;
    envelope = {
      ...envelope,
      spentCents: envelope.spentCents + amount,
      status: envelope.spentCents + amount >= envelope.capCents ? "exhausted" : "active",
    };
    reservedCents += amount;
    return { ...envelope };
  }
  async function refund(amount: number): Promise<void> {
    if (!envelope) return;
    envelope = {
      ...envelope,
      spentCents: Math.max(0, envelope.spentCents - amount),
      status: envelope.status === "exhausted" && envelope.spentCents - amount < envelope.capCents ? "active" : envelope.status,
    };
    reservedCents -= amount;
  }
  const deps: AcquisitionDispatcherDeps = {
    resolveCaps: () => opts.caps,
    providers: createAcquisitionProviders({}, opts.providers),
    envelopes: {
      getActiveAdsEnvelope: () => Promise.resolve(activeEnvelope()),
      reserveAdsSpend: (_w, _i, amount) => reserve(amount),
      refundAdsSpend: (_w, _i, amount) => refund(amount),
      debitAdsEnvelope: (_w, _i, amount) => reserve(amount).then(() => undefined),
    },
    suppressions: { loadSuppressed: () => Promise.resolve(opts.suppressed ?? new Set()) },
    receipts: {
      record: (r) => {
        receipts.push(r);
        return Promise.resolve();
      },
    },
    emailWindow: { warmupState: () => Promise.resolve(opts.warmup ?? { dayIndex: 99, sentToday: 0 }) },
    footerInfo: () => ("footer" in opts ? (opts.footer ?? null) : footer),
  };
  return {
    dispatcher: createAcquisitionDispatcher(deps),
    receipts,
    debited: () => reservedCents,
    envelope: () => envelope,
  };
}

const ctx = { workspaceId: WS, requesterMemberId: "m-1" };

describe("dispatcher fall-through (default-OFF byte-for-byte)", () => {
  it("returns null for a non-acquisition kind", async () => {
    const { dispatcher } = harness({ caps: resolveAcquisitionCaps({ enabled: true, email: true }) });
    expect(await dispatcher.dispatch({ kind: "support.reply", summary: "hi" }, ctx)).toBeNull();
  });

  it("returns null when the channel is not cleared to execute (flag off)", async () => {
    const { dispatcher } = harness({ caps: resolveAcquisitionCaps({ enabled: false }) });
    expect(await dispatcher.dispatch({ kind: "email.send", summary: "hi" }, ctx)).toBeNull();
  });

  it("returns null when master is on but the channel flag is off", async () => {
    const { dispatcher } = harness({ caps: resolveAcquisitionCaps({ enabled: true, social: false }) });
    expect(await dispatcher.dispatch({ kind: "social.post", summary: "hi" }, ctx)).toBeNull();
  });
});

describe("ads: spend inside the owner envelope (AC1)", () => {
  const caps = resolveAcquisitionCaps({ enabled: true, ads: true });

  it("spends within the envelope and debits it", async () => {
    const { dispatcher, receipts, debited, envelope } = harness({
      caps,
      envelope: { capCents: 10_000, spentCents: 0, status: "active" },
    });
    const r = await dispatcher.dispatch(
      { kind: "ad.spend", summary: "Google starter", amountCents: 3_000, campaign: "g1" },
      ctx,
    );
    expect(r?.executed).toBe(true);
    expect(receipts[0]!.channel).toBe("ads");
    expect(receipts[0]!.amountCents).toBe(3_000);
    expect(receipts[0]!.detail.envelopeRemaining).toBe(7_000);
    expect(debited()).toBe(3_000);
    expect(envelope()!.spentCents).toBe(3_000);
  });

  it("reserves atomically so concurrent spends cannot exceed the cap", async () => {
    const { dispatcher, receipts, envelope } = harness({
      caps,
      envelope: { capCents: 8_000, spentCents: 0, status: "active" },
    });

    const results = await Promise.allSettled([
      dispatcher.dispatch({ kind: "ad.spend", summary: "a", amountCents: 4_000 }, ctx),
      dispatcher.dispatch({ kind: "ad.spend", summary: "b", amountCents: 4_000 }, ctx),
      dispatcher.dispatch({ kind: "ad.spend", summary: "c", amountCents: 4_000 }, ctx),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(envelope()!.spentCents).toBe(8_000);
    expect(envelope()!.spentCents).toBeLessThanOrEqual(envelope()!.capCents);
    expect(receipts).toHaveLength(2);
  });

  it("refunds the reserved envelope spend when the provider fails", async () => {
    const { dispatcher, receipts, debited, envelope } = harness({
      caps,
      envelope: { capCents: 10_000, spentCents: 1_000, status: "active" },
      providers: {
        ads: {
          kind: "failing-ads",
          spend: () =>
            Promise.resolve({
              status: "failed",
              externalId: null,
              provider: "failing-ads",
              detail: { error: "provider down" },
            }),
        },
      },
    });

    const result = await dispatcher.dispatch(
      { kind: "ad.spend", summary: "Google starter", amountCents: 3_000, campaign: "g1" },
      ctx,
    );

    expect(result?.executed).toBe(false);
    expect(receipts[0]!.status).toBe("failed");
    expect(receipts[0]!.detail.envelopeRemaining).toBe(9_000);
    expect(debited()).toBe(0);
    expect(envelope()!.spentCents).toBe(1_000);
  });

  it("throws (needs owner) when over the envelope remaining", async () => {
    const { dispatcher } = harness({
      caps,
      envelope: { capCents: 10_000, spentCents: 9_000, status: "active" },
    });
    await expect(
      dispatcher.dispatch({ kind: "ad.spend", summary: "x", amountCents: 3_000 }, ctx),
    ).rejects.toBeInstanceOf(ActionExecutionError);
  });

  it("throws when there is no active envelope", async () => {
    const { dispatcher } = harness({ caps, envelope: null });
    await expect(
      dispatcher.dispatch({ kind: "ad.spend", summary: "x", amountCents: 100 }, ctx),
    ).rejects.toThrow(/envelope/);
  });

  it("routes the loaded envelope through decideSpendWithinEnvelope", async () => {
    const { dispatcher } = harness({
      caps,
      envelope: { capCents: 10_000, spentCents: 1_000, status: "paused" },
      loadInactiveEnvelope: true,
    });

    await expect(
      dispatcher.dispatch({ kind: "ad.spend", summary: "x", amountCents: 100 }, ctx),
    ).rejects.toThrow("no active budget envelope (status: paused) — needs owner approval");
  });
});

describe("email: suppression + footer + warmup enforced in code (AC2)", () => {
  const caps = resolveAcquisitionCaps({ enabled: true, email: true });

  it("sends to the cleared remainder, dropping suppressed recipients", async () => {
    const { dispatcher, receipts } = harness({
      caps,
      suppressed: new Set(["bad@x.com"]),
    });
    const r = await dispatcher.dispatch(
      {
        kind: "email.send",
        summary: "Launch",
        subject: "Launch",
        body: "Hello",
        recipients: ["good@x.com", "bad@x.com"],
      },
      ctx,
    );
    expect(r?.executed).toBe(true);
    expect(receipts[0]!.recipientCount).toBe(1);
    expect(receipts[0]!.detail.suppressedDropped).toBe(1);
  });

  it("blocks the send when footer info is missing (no CAN-SPAM footer)", async () => {
    const { dispatcher } = harness({ caps, footer: null });
    await expect(
      dispatcher.dispatch(
        { kind: "email.send", summary: "x", body: "hi", recipients: ["a@x.com"] },
        ctx,
      ),
    ).rejects.toThrow(/compliance/);
  });

  it("blocks the send when every recipient is suppressed", async () => {
    const { dispatcher } = harness({ caps, suppressed: new Set(["a@x.com"]) });
    await expect(
      dispatcher.dispatch(
        { kind: "email.send", summary: "x", body: "hi", recipients: ["a@x.com"] },
        ctx,
      ),
    ).rejects.toThrow(/compliance/);
  });

  it("respects domain warmup headroom (only sends what the day's cap grants)", async () => {
    const { dispatcher, receipts } = harness({
      caps,
      warmup: { dayIndex: 0, sentToday: 49 }, // day-0 cap 50 → 1 grantable
    });
    await dispatcher.dispatch(
      {
        kind: "email.send",
        summary: "x",
        body: "hi",
        recipients: ["a@x.com", "b@x.com", "c@x.com"],
      },
      ctx,
    );
    expect(receipts[0]!.recipientCount).toBe(1);
  });

  it("throws when warmup grants zero headroom", async () => {
    const { dispatcher } = harness({ caps, warmup: { dayIndex: 0, sentToday: 50 } });
    await expect(
      dispatcher.dispatch(
        { kind: "email.send", summary: "x", body: "hi", recipients: ["a@x.com"] },
        ctx,
      ),
    ).rejects.toThrow(/warmup/);
  });
});

describe("social + seo", () => {
  it("publishes a social post and records the receipt (AC3)", async () => {
    const { dispatcher, receipts } = harness({
      caps: resolveAcquisitionCaps({ enabled: true, social: true }),
    });
    const r = await dispatcher.dispatch(
      { kind: "social.post", summary: "thread", network: "x" },
      ctx,
    );
    expect(r?.executed).toBe(true);
    expect(receipts[0]!.channel).toBe("social");
  });

  it("records a failed receipt and rethrows when the provider throws (AC3, no silent drop)", async () => {
    const failing = {
      kind: "boom",
      publish: () => Promise.reject(new Error("rate limited")),
    };
    const { dispatcher, receipts } = harness({
      caps: resolveAcquisitionCaps({ enabled: true, social: true }),
      providers: { social: failing },
    });
    await expect(
      dispatcher.dispatch({ kind: "social.post", summary: "thread", network: "x" }, ctx),
    ).rejects.toThrow();
    expect(receipts[0]!.status).toBe("failed");
  });

  it("publishes SEO content to the venture site (AC4)", async () => {
    const { dispatcher, receipts } = harness({
      caps: resolveAcquisitionCaps({ enabled: true, seo: true }),
    });
    const r = await dispatcher.dispatch(
      { kind: "content.publish", summary: "Guide", section: "guides", slug: "intro", title: "Guide" },
      ctx,
    );
    expect(r?.executed).toBe(true);
    expect(receipts[0]!.channel).toBe("seo");
  });
});

describe("dry-run providers never touch the network", () => {
  it("stamp dryRun on the outcome", async () => {
    const ads: SendOutcome = await dryRunAdsProvider.spend({
      workspaceId: WS,
      ideaId: null,
      campaign: "c",
      amountCents: 100,
    });
    expect(ads.provider).toBe("dryrun");
    expect(ads.detail.dryRun).toBe(true);
    const email = await dryRunEspProvider.send({
      workspaceId: WS,
      ideaId: null,
      subject: "s",
      body: appendComplianceFooter("b", footer),
      recipients: ["a@x.com"],
    });
    expect(email.detail.dryRun).toBe(true);
  });
});
