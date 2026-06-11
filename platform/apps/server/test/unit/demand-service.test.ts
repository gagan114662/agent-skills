import { describe, it, expect, beforeEach } from "vitest";
import {
  DemandValidationService,
  DemandNotFoundError,
  DemandStateError,
  EthicsDisclosureError,
  type DemandExperiment,
  type ExperimentStore,
  type RecordSignalInput,
  type SignalStore,
  type RefundStore,
  type LandingDeployer,
  type CheckoutMinter,
  type Refunder,
} from "../../src/demand/service.js";
import { ExperimentSpecError, type ExperimentSpec } from "../../src/demand/experiment.js";
import type { DemandSignal } from "../../src/demand/provenance.js";

let seq = 0;
const id = () => `id-${++seq}`;

function makeExperimentStore(): ExperimentStore & { rows: Map<string, DemandExperiment> } {
  const rows = new Map<string, DemandExperiment>();
  return {
    rows,
    async create(input) {
      const exp: DemandExperiment = { ...input, id: id(), status: "registered", landingUrl: null, checkoutUrl: null, createdAt: new Date() };
      rows.set(exp.id, exp);
      return exp;
    },
    async get(_w, i) {
      return rows.get(i);
    },
    async list(w, vid) {
      return [...rows.values()].filter((r) => r.workspaceId === w && (!vid || r.ventureIdeaId === vid));
    },
    async markLive(_w, i, landingUrl, checkoutUrl) {
      const r = rows.get(i)!;
      const next = { ...r, status: "live" as const, landingUrl, checkoutUrl };
      rows.set(i, next);
      return next;
    },
  };
}

function makeSignalStore(): SignalStore & { rows: RecordSignalInput[] } {
  const rows: RecordSignalInput[] = [];
  const seen = new Set<string>();
  const toSignal = (r: RecordSignalInput): DemandSignal => ({
    signalClass: r.signalClass,
    provenance: { kind: "externally_attributed", attribution: { source: r.source, externalRef: r.externalRef } },
    amountCents: r.amountCents,
    currency: r.currency,
  });
  return {
    rows,
    async record(input) {
      const key = `${input.workspaceId}:${input.experimentId}:${input.externalRef}`;
      if (seen.has(key)) return { deduped: true };
      seen.add(key);
      rows.push(input);
      return { deduped: false };
    },
    async list(w, e) {
      return rows.filter((r) => r.workspaceId === w && r.experimentId === e).map(toSignal);
    },
    async listForIdea(w, vid) {
      return rows.filter((r) => r.workspaceId === w && r.ventureIdeaId === vid).map(toSignal);
    },
  };
}

const W = "ws-1";
function spec(over: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    hypothesis: "Strangers will pay",
    successClass: "paid",
    denominatorClass: "visit",
    passThreshold: 0.05,
    minSample: 10,
    windowStartMs: 1000,
    windowEndMs: 2000,
    ...over,
  };
}

let experiments: ReturnType<typeof makeExperimentStore>;
let signals: ReturnType<typeof makeSignalStore>;
let refunds: RefundStore & { rows: unknown[] };
let refunder: Refunder & { calls: unknown[] };
let deployer: LandingDeployer;
let checkout: CheckoutMinter;
let nowMs = 2500;

function makeService() {
  refunds = Object.assign({ rows: [] as unknown[] }, { record: async (r: unknown) => void refunds.rows.push(r) });
  refunder = Object.assign({ calls: [] as unknown[] }, { refund: async (r: unknown) => void refunder.calls.push(r) });
  deployer = { deploy: async ({ experimentId }) => ({ url: `https://land/${experimentId}` }) };
  checkout = { mint: async ({ experimentId }) => ({ url: `https://pay/${experimentId}` }) };
  return new DemandValidationService({
    experiments,
    signals,
    refunds,
    deployer,
    checkout,
    refunder,
    now: () => new Date(nowMs),
  });
}

beforeEach(() => {
  experiments = makeExperimentStore();
  signals = makeSignalStore();
  nowMs = 2500;
});

describe("DemandValidationService", () => {
  it("register validates the locked spec (rejects a bad bar)", async () => {
    const svc = makeService();
    await expect(
      svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec({ passThreshold: 2 }), availability: "available", disclosure: null, createdByMemberId: null }),
    ).rejects.toBeInstanceOf(ExperimentSpecError);
  });

  it("launch deploys the fake-door + mints a checkout and marks the experiment live", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: "idea-1", spec: spec(), availability: "available", disclosure: null, createdByMemberId: null });
    const live = await svc.launch(W, exp.id);
    expect(live.status).toBe("live");
    expect(live.landingUrl).toContain("land/");
    expect(live.checkoutUrl).toContain("pay/");
  });

  it("ETHICS: refuses to launch a pre-launch (waitlist) checkout without a disclosure", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec(), availability: "waitlist", disclosure: "  ", createdByMemberId: null });
    await expect(svc.launch(W, exp.id)).rejects.toBeInstanceOf(EthicsDisclosureError);
  });

  it("launches a waitlist checkout once a disclosure is present", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec(), availability: "waitlist", disclosure: "Pre-order — not yet available; charge is a deposit.", createdByMemberId: null });
    expect((await svc.launch(W, exp.id)).status).toBe("live");
  });

  it("refuses to re-launch a live experiment (409 state)", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec(), availability: "available", disclosure: null, createdByMemberId: null });
    await svc.launch(W, exp.id);
    await expect(svc.launch(W, exp.id)).rejects.toBeInstanceOf(DemandStateError);
  });

  it("throws DemandNotFoundError for an unknown experiment", async () => {
    const svc = makeService();
    await expect(svc.view(W, "nope")).rejects.toBeInstanceOf(DemandNotFoundError);
  });

  it("ETHICS: auto-refunds a charge that lands before availability, once (replay does not double-refund)", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec(), availability: "preorder", disclosure: "Deposit only", createdByMemberId: null });
    const first = await svc.ingestCheckout({ workspaceId: W, experimentId: exp.id, externalRef: "evt_1", amountCents: 2000, currency: "usd" });
    expect(first).toEqual({ deduped: false, refunded: true });
    expect(refunder.calls).toHaveLength(1);
    expect(refunds.rows).toHaveLength(1);
    // Replay of the same Stripe event id: deduped, no second refund.
    const replay = await svc.ingestCheckout({ workspaceId: W, experimentId: exp.id, externalRef: "evt_1", amountCents: 2000, currency: "usd" });
    expect(replay).toEqual({ deduped: true, refunded: false });
    expect(refunder.calls).toHaveLength(1);
  });

  it("does NOT refund a charge when the product is available", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: null, spec: spec(), availability: "available", disclosure: null, createdByMemberId: null });
    const r = await svc.ingestCheckout({ workspaceId: W, experimentId: exp.id, externalRef: "evt_2", amountCents: 2000, currency: "usd" });
    expect(r).toEqual({ deduped: false, refunded: false });
    expect(refunder.calls).toHaveLength(0);
  });

  it("captures the funnel and evaluates against the locked bar (PASS after the window with enough sample)", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: "idea-9", spec: spec({ minSample: 10, passThreshold: 0.05 }), availability: "available", disclosure: null, createdByMemberId: null });
    for (let i = 0; i < 12; i++) await svc.recordSignal(W, exp.id, "visit", `v${i}`);
    await svc.ingestCheckout({ workspaceId: W, experimentId: exp.id, externalRef: "evt_paid", amountCents: 3000, currency: "usd" });
    nowMs = 3000; // window closed
    const view = await svc.view(W, exp.id);
    expect(view.funnel.counts.visit).toBe(12);
    expect(view.funnel.counts.paid).toBe(1);
    expect(view.evaluation.status).toBe("PASS");
  });

  it("exposes only externally-attributed demand evidence for an idea (the #96 overlay source)", async () => {
    const svc = makeService();
    const exp = await svc.register({ workspaceId: W, ventureIdeaId: "idea-x", spec: spec(), availability: "available", disclosure: null, createdByMemberId: null });
    await svc.recordSignal(W, exp.id, "visit", "v1");
    await svc.ingestCheckout({ workspaceId: W, experimentId: exp.id, externalRef: "evt_x", amountCents: 5000, currency: "usd" });
    const evidence = await svc.externalDemandEvidence(W, "idea-x");
    expect(evidence.map((e) => e.signalClass).sort()).toEqual(["paid", "visit"]);
  });
});
