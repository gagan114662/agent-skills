import { describe, it, expect } from "vitest";
import {
  DiscoveryService,
  DiscoveryValidationError,
  type GrowthEmitter,
  type PipelineStore,
  type PqlStore,
  type SignalDefStore,
  type SignalStore,
} from "../../src/discovery/service.js";
import type {
  DiscoverySignalRecord,
  PipelineEntryRecord,
  PqlEventRecord,
  SignalDefRecord,
} from "../../src/discovery/types.js";
import type { DiscoveryCaps } from "../../src/discovery/caps.js";
import {
  aggregateFounderConsole,
  type FounderConsoleInput,
} from "../../src/founder-console/aggregate.js";
import { funnelFromEvents } from "../../src/growth/score.js";
import type { GrowthEventKind, GrowthEventRecord } from "../../src/growth/types.js";

const NOW = Date.parse("2026-06-14T00:00:00Z");

interface EmittedGrowth {
  workspaceId: string;
  ideaId: string | null;
  kind: GrowthEventKind;
  source: string;
  value: number;
  metadata: Record<string, unknown>;
}

/** In-memory fakes for the discovery seams — no DB, so this runs in the `pnpm test` unit gate. */
function makeHarness() {
  let idc = 0;
  const nextId = (): string => `id-${++idc}`;
  const signals: DiscoverySignalRecord[] = [];
  const defs: SignalDefRecord[] = [];
  const pqls: PqlEventRecord[] = [];
  const pipeline: PipelineEntryRecord[] = [];
  const emitted: EmittedGrowth[] = [];

  const signalStore: SignalStore = {
    async insert(i) {
      const rec: DiscoverySignalRecord = {
        id: nextId(),
        workspaceId: i.workspaceId,
        ideaId: i.ideaId,
        prospectKey: i.prospectKey,
        kind: i.kind,
        value: i.value,
        role: i.role,
        source: i.source,
        externalRef: i.externalRef,
        occurredAt: i.occurredAt,
        detail: i.detail,
        createdAt: i.occurredAt,
      };
      signals.push(rec);
      return rec;
    },
    async listForProspect(w, p, idea) {
      return signals.filter(
        (s) =>
          s.workspaceId === w &&
          s.prospectKey === p &&
          (idea === undefined || idea === null || s.ideaId === idea),
      );
    },
    async list(w, idea) {
      return signals.filter((s) => s.workspaceId === w && (idea === undefined || s.ideaId === idea));
    },
  };

  const defStore: SignalDefStore = {
    async upsert(i) {
      const existing = defs.find(
        (d) => d.workspaceId === i.workspaceId && d.ideaId === i.ideaId && d.label === i.label,
      );
      if (existing) {
        Object.assign(existing, i, { updatedAt: new Date(NOW) });
        return existing;
      }
      const rec: SignalDefRecord = {
        id: nextId(),
        createdAt: new Date(NOW),
        updatedAt: new Date(NOW),
        ...i,
      };
      defs.push(rec);
      return rec;
    },
    async list(w) {
      return defs.filter((d) => d.workspaceId === w);
    },
  };

  const pqlStore: PqlStore = {
    async emittedKeys(w) {
      return new Set(
        pqls.filter((p) => p.workspaceId === w).map((p) => `${p.prospectKey} ${p.defId ?? ""}`),
      );
    },
    async insert(i) {
      const dup = pqls.find(
        (p) =>
          p.workspaceId === i.workspaceId && p.prospectKey === i.prospectKey && p.defId === i.defId,
      );
      if (dup) return dup;
      const rec: PqlEventRecord = { id: nextId(), createdAt: i.occurredAt, ...i };
      pqls.push(rec);
      return rec;
    },
    async list(w, idea) {
      return pqls.filter((p) => p.workspaceId === w && (idea === undefined || p.ideaId === idea));
    },
  };

  const pipelineStore: PipelineStore = {
    async enter(i) {
      const dup = pipeline.find(
        (e) =>
          e.workspaceId === i.workspaceId &&
          e.prospectKey === i.prospectKey &&
          e.stage === i.stage,
      );
      if (dup) return;
      pipeline.push({ id: nextId(), createdAt: i.enteredAt, ...i });
    },
    async list(w, idea) {
      return pipeline.filter((e) => e.workspaceId === w && (idea === undefined || e.ideaId === idea));
    },
  };

  const emitter: GrowthEmitter = {
    async record(workspaceId, input) {
      emitted.push({ workspaceId, ...input });
    },
  };

  const caps: DiscoveryCaps = {
    enabled: false,
    queueLimit: 50,
    defaultWindowDays: 14,
    ownerWorkspaceId: null,
  };

  const service = new DiscoveryService({
    signals: signalStore,
    defs: defStore,
    pqls: pqlStore,
    pipeline: pipelineStore,
    growth: emitter,
    caps: () => caps,
    now: () => new Date(NOW),
  });

  return { service, signals, defs, pqls, pipeline, emitted };
}

describe("DiscoveryService.ingestSignal (signal → PQL event + growth funnel emission)", () => {
  it("emits a PQL the moment real usage crosses the owner-defined power-user threshold", async () => {
    const h = makeHarness();
    await h.service.defineSignal("ws-1", {
      kind: "power_user_threshold",
      label: "power user",
      threshold: 5,
      weight: 60,
    });

    // First two signals (2 + 2 = 4) stay under the threshold — no PQL yet.
    const r1 = await h.service.ingestSignal("ws-1", { prospectKey: "vp-1", kind: "usage_event", value: 2 });
    const r2 = await h.service.ingestSignal("ws-1", { prospectKey: "vp-1", kind: "usage_event", value: 2 });
    expect(r1.pqls).toHaveLength(0);
    expect(r2.pqls).toHaveLength(0);

    // The third (now 6 ≥ 5) qualifies → ONE PQL emitted on the owner-defined signal.
    const r3 = await h.service.ingestSignal("ws-1", { prospectKey: "vp-1", kind: "usage_event", value: 2 });
    expect(r3.pqls).toHaveLength(1);
    expect(r3.pqls[0]!.defKind).toBe("power_user_threshold");
    expect(r3.pqls[0]!.score).toBeGreaterThan(0);
    expect(r3.pqls[0]!.verified).toBe(false); // a prediction — UNVERIFIED until externally confirmed

    // The prospect entered the top GTM stage (outreach) — READ-ONLY: we do not send.
    expect(h.pipeline.find((e) => e.prospectKey === "vp-1" && e.stage === "outreach")).toBeDefined();

    // Growth funnel lit up: one `acquisition` (first-seen prospect) + one `activation` (the PQL).
    expect(h.emitted.filter((e) => e.kind === "acquisition")).toHaveLength(1);
    expect(h.emitted.filter((e) => e.kind === "activation")).toHaveLength(1);
  });

  it("an externally-grounded conversion advances the pipeline + emits a verified conversion event", async () => {
    const h = makeHarness();
    await h.service.ingestSignal("ws-1", {
      prospectKey: "vp-2",
      kind: "conversion",
      externalRef: "evt_stripe_1",
    });
    expect(h.pipeline.find((e) => e.prospectKey === "vp-2" && e.stage === "conversion" && e.verified)).toBeDefined();
    expect(h.emitted.filter((e) => e.kind === "conversion")).toHaveLength(1);
  });

  it("rejects a PII-looking prospect key (no PII in the signal store)", async () => {
    const h = makeHarness();
    await expect(
      h.service.ingestSignal("ws-1", { prospectKey: "alice@example.com", kind: "usage_event" }),
    ).rejects.toBeInstanceOf(DiscoveryValidationError);
    expect(h.signals).toHaveLength(0);
  });
});

describe("DiscoveryService.queue / pipelineSummary (read-only surfaces)", () => {
  it("returns a non-empty ranked queue for a seeded venture, top prospect carries its qualifying signal", async () => {
    const h = makeHarness();
    await h.service.defineSignal("ws-1", { kind: "power_user_threshold", label: "power", threshold: 5, weight: 60 });
    await h.service.defineSignal("ws-1", { kind: "pricing_page_visit", label: "pricing", threshold: 1, weight: 80 });
    await h.service.ingestSignal("ws-1", { prospectKey: "vp-eng", kind: "usage_event", value: 9 });
    await h.service.ingestSignal("ws-1", { prospectKey: "vp-eng", kind: "pricing_page_visit" });
    await h.service.ingestSignal("ws-1", { prospectKey: "tire-kicker", kind: "usage_event", value: 1 });

    const queue = await h.service.queue("ws-1", { limit: 5 });
    expect(queue.unverified).toBe(true);
    expect(queue.prospects.length).toBeGreaterThan(0);
    const top = queue.prospects[0]!;
    expect(top.prospectKey).toBe("vp-eng");
    expect(top.likelihoodLabel).toBe("UNVERIFIED");
    expect(top.qualifyingDefs.length).toBeGreaterThanOrEqual(1);
    expect(top.qualifyingSignalKinds.length).toBeGreaterThan(0);
  });

  it("summarizes the 5-stage GTM pipeline with the PQL count at the top", async () => {
    const h = makeHarness();
    await h.service.defineSignal("ws-1", { kind: "pricing_page_visit", label: "pricing", threshold: 1, weight: 80 });
    await h.service.ingestSignal("ws-1", { prospectKey: "vp-eng", kind: "pricing_page_visit" });
    await h.service.ingestSignal("ws-1", { prospectKey: "vp-eng", kind: "conversion", externalRef: "evt_1" });

    const summary = await h.service.pipelineSummary("ws-1");
    expect(summary.pqlCount).toBeGreaterThan(0);
    expect(summary.metrics.stages.map((s) => s.stage)).toEqual([
      "outreach",
      "discovery",
      "conversion",
      "onboarding",
      "post_sales",
    ]);
    expect(summary.metrics.stages.find((s) => s.stage === "outreach")!.prospects).toBe(1);
    expect(summary.metrics.stages.find((s) => s.stage === "conversion")!.prospects).toBe(1);
  });
});

describe("founder-console growth shows non-zero, event-driven counts (AC2)", () => {
  it("discovery-emitted growth events drive a non-zero funnel + non-zero discovery pipeline in the console", async () => {
    const h = makeHarness();
    await h.service.defineSignal("ws-1", { kind: "power_user_threshold", label: "power", threshold: 3, weight: 60 });
    await h.service.ingestSignal("ws-1", { prospectKey: "vp-eng", kind: "usage_event", value: 5 });

    // The growth events the discovery engine emitted feed the SAME pure funnel the console reads.
    const events: GrowthEventRecord[] = h.emitted.map((e, i) => ({
      id: `g-${i}`,
      workspaceId: e.workspaceId,
      ideaId: e.ideaId,
      kind: e.kind,
      source: e.source,
      value: e.value,
      metadata: e.metadata,
      occurredAt: new Date(NOW),
      createdAt: new Date(NOW),
    }));
    expect(events.length).toBeGreaterThan(0);
    const funnel = funnelFromEvents(events);
    expect(funnel.acquisition).toBeGreaterThan(0);
    expect(funnel.activation).toBeGreaterThan(0);

    const pipe = await h.service.pipelineSummary("ws-1");
    const out = aggregateFounderConsole(
      fcInput({
        growth: { totalEvents: events.length, funnel, score: 0, topSource: null, experiments: [] },
        discoveryPipeline: {
          stages: pipe.metrics.stages.map((s) => ({
            stage: s.stage,
            prospects: s.prospects,
            verifiedProspects: s.verifiedProspects,
          })),
          totalProspects: pipe.metrics.totalProspects,
          pqlCount: pipe.pqlCount,
        },
      }),
    );

    // The growth panel is no longer all-zeros — it is event-driven off real discovery signals.
    expect(out.growth.acquisition).toBeGreaterThan(0);
    expect(out.growth.activation).toBeGreaterThan(0);
    expect(out.discoveryPipeline.pqlCount).toBeGreaterThan(0);
    expect(out.discoveryPipeline.stages.find((s) => s.stage === "outreach")!.prospects).toBeGreaterThan(0);
  });
});

/** A quiet founder-console baseline; override per case. Mirrors the founder-console-aggregate test helper. */
function fcInput(over: Partial<FounderConsoleInput> = {}): FounderConsoleInput {
  return {
    workspaceId: "ws-1",
    nowMs: NOW,
    fleet: { tenantInFlight: 0, globalInFlight: 0, sessionsThisWindow: 0 },
    ventures: [],
    revenue: { currency: "usd", totalCents: 0, paymentCount: 0, evidenceCount: 0 },
    budget: {
      window: "2026-06",
      estimatedCostCents: 0,
      budgetCents: 0,
      computeSeconds: 0,
      sessionsStarted: 0,
    },
    approvals: [],
    switches: { killSwitch: false, maintenance: { enabled: false } },
    gateBoundaries: { owned: [], history: [] },
    usageTrend: [],
    forecastWindow: "2026-07",
    infraBudgetCeilingCents: 0,
    tenantConcurrency: 0,
    ...over,
  };
}
