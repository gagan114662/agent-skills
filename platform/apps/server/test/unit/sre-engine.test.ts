import { describe, it, expect, beforeEach, vi } from "vitest";
import { SreEngine, type SreIncidentStore } from "../../src/sre/engine.js";
import { resetMetrics } from "../../src/observability/metrics.js";
import { newId } from "../../src/db/id.js";
import type { SreCaps } from "../../src/sre/caps.js";
import type { IncidentRecord, ServiceSignal, SloKind } from "../../src/sre/types.js";

const silentLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as const;

const NOW = new Date("2026-06-10T12:00:00Z");

/** An in-memory incident store implementing the engine seam, for assertions. */
function memStore(): SreIncidentStore & { rows: IncidentRecord[] } {
  const rows: IncidentRecord[] = [];
  const key = (ws: string, svc: string, kind: SloKind) => `${ws}|${svc}|${kind}`;
  return {
    rows,
    async getOpen(ws, svc, kind) {
      return (
        rows.find((r) => r.status !== "resolved" && key(r.workspaceId, r.service, r.sloKind) === key(ws, svc, kind)) ??
        null
      );
    },
    async open(input) {
      const row: IncidentRecord = {
        id: newId(),
        workspaceId: input.workspaceId,
        service: input.service,
        sloKind: input.sloKind,
        severity: input.severity,
        status: "firing",
        observedValue: input.observedValue,
        targetValue: input.targetValue,
        budgetRemaining: input.budgetRemaining,
        triageSessionId: null,
        postmortemPath: null,
        openedAt: input.now,
        lastNotifiedAt: input.now,
        resolvedAt: null,
      };
      rows.push(row);
      return row;
    },
    async attachTriage(id, triageSessionId) {
      const r = rows.find((x) => x.id === id);
      if (r) r.triageSessionId = triageSessionId;
    },
    async markEscalated(id) {
      const r = rows.find((x) => x.id === id);
      if (r) r.status = "escalated";
    },
    async recordNotified(id, now) {
      const r = rows.find((x) => x.id === id);
      if (r) r.lastNotifiedAt = now;
    },
    async resolve(input) {
      const r = rows.find((x) => x.id === input.id)!;
      r.status = "resolved";
      r.postmortemPath = input.postmortemPath;
      r.resolvedAt = input.now;
      return r;
    },
  };
}

const apiCaps: SreCaps = {
  enabled: true,
  cooldownMs: 60_000,
  services: [
    { service: "api", targets: [{ kind: "availability", target: 0.99 }, { kind: "latency_p95", target: 500 }] },
  ],
};

interface EngineConfig {
  signals: Map<string, ServiceSignal>;
  caps: SreCaps;
  killSwitch: boolean;
  maintenancePaused?: () => Promise<boolean>;
  store: SreIncidentStore & { rows: IncidentRecord[] };
  triageTargetNull?: boolean;
}

function makeEngine(cfg: Partial<EngineConfig>) {
  const store = cfg.store ?? memStore();
  const triage = { launch: vi.fn(async () => ({ id: `triage-${newId()}` })) };
  const escalator = { escalate: vi.fn(async () => ({ id: `appr-${newId()}` })) };
  const notifier = { notify: vi.fn(async () => {}) };
  const postmortems = { write: vi.fn(async () => {}) };
  const readSignals = vi.fn(async () => cfg.signals ?? new Map());
  const triageTarget = {
    resolve: vi.fn(async () =>
      cfg.triageTargetNull
        ? null
        : { channelId: "ch-1", agentMemberId: "agent-1", createdByMemberId: "agent-1" },
    ),
  };
  const bundle = {
    context: vi.fn(async () => ({ recentDeploys: [], traceHints: [], runbookLinks: ["docs/playbooks/restore-runbook.md"] })),
  };
  const engine = new SreEngine({
    readSignals,
    listWorkspaceIds: async () => ["ws-1"],
    caps: () => cfg.caps ?? apiCaps,
    killSwitch: async () => cfg.killSwitch ?? false,
    incidents: store,
    triage,
    triageTarget,
    bundle,
    escalator,
    notifier,
    postmortems,
    maintenancePaused: cfg.maintenancePaused,
    logger: silentLogger,
    now: () => NOW,
  });
  return { engine, store, triage, escalator, notifier, postmortems, readSignals, triageTarget, bundle };
}

const healthy: ServiceSignal = {
  service: "api",
  windowRequests: 1000,
  windowErrors: 0,
  p95LatencyMs: 200,
  queueLagSeconds: 0,
  healthy: true,
};

beforeEach(() => resetMetrics());

describe("SreEngine.tickAll — gating", () => {
  it("skips the whole pass during maintenance, before any signal read", async () => {
    const { engine, readSignals } = makeEngine({
      maintenancePaused: async () => true,
      signals: new Map([["api", healthy]]),
    });
    await engine.tickAll();
    expect(readSignals).not.toHaveBeenCalled();
  });

  it("skips a workspace whose kill switch is engaged (no incident opened)", async () => {
    const { engine, store } = makeEngine({
      killSwitch: true,
      signals: new Map([["api", { ...healthy, windowErrors: 900 }]]),
    });
    const r = await engine.tickWorkspace("ws-1", new Map([["api", { ...healthy, windowErrors: 900 }]]), NOW);
    expect(r.skipped).toBe("kill_switch");
    expect(store.rows).toHaveLength(0);
  });

  it("skips a workspace where the loop is disabled", async () => {
    const { engine, store } = makeEngine({
      caps: { ...apiCaps, enabled: false },
      signals: new Map([["api", { ...healthy, windowErrors: 900 }]]),
    });
    const r = await engine.tickWorkspace("ws-1", new Map([["api", { ...healthy, windowErrors: 900 }]]), NOW);
    expect(r.skipped).toBe("disabled");
    expect(store.rows).toHaveLength(0);
  });
});

describe("SreEngine — incident lifecycle", () => {
  it("a healthy service opens no incident", async () => {
    const { engine, store } = makeEngine({});
    await engine.tickWorkspace("ws-1", new Map([["api", healthy]]), NOW);
    expect(store.rows).toHaveLength(0);
  });

  it("a warning breach opens an incident, notifies, and launches a triage session", async () => {
    // 5% errors against a 99% target → availability 0.95 < 0.99 → breached. Budget gone (allowance
    // 0.01, error 0.05) → critical actually; use latency for a clean warning case.
    const slow: ServiceSignal = { ...healthy, p95LatencyMs: 750 }; // 1.5x the 500ms target → warning
    const { engine, store, triage, notifier } = makeEngine({});
    await engine.tickWorkspace("ws-1", new Map([["api", slow]]), NOW);

    const incident = store.rows.find((r) => r.sloKind === "latency_p95");
    expect(incident).toBeTruthy();
    expect(incident!.status).toBe("firing");
    expect(incident!.severity).toBe("warning");
    expect(triage.launch).toHaveBeenCalledTimes(1);
    expect(incident!.triageSessionId).toBeTruthy();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "opened" }));
  });

  it("a critical breach escalates to the #13 queue and marks the incident escalated", async () => {
    const down: ServiceSignal = { ...healthy, windowRequests: 1000, windowErrors: 900 }; // avail 0.1
    const { engine, store, escalator, triage } = makeEngine({});
    await engine.tickWorkspace("ws-1", new Map([["api", down]]), NOW);

    const incident = store.rows.find((r) => r.sloKind === "availability");
    expect(incident!.severity).toBe("critical");
    expect(incident!.status).toBe("escalated");
    expect(escalator.escalate).toHaveBeenCalledTimes(1);
    // Triage still launches even for a critical incident.
    expect(triage.launch).toHaveBeenCalled();
  });

  it("recovery resolves the open incident and drafts a postmortem under docs/postmortems/", async () => {
    const store = memStore();
    // Seed an open incident as if a prior tick opened it.
    const opened = await store.open({
      workspaceId: "ws-1",
      service: "api",
      sloKind: "latency_p95",
      severity: "warning",
      observedValue: 750,
      targetValue: 500,
      budgetRemaining: 0.5,
      now: new Date("2026-06-10T11:50:00Z"),
    });
    await store.attachTriage(opened.id, "triage-x");

    const { engine, postmortems } = makeEngine({ store });
    await engine.tickWorkspace("ws-1", new Map([["api", healthy]]), NOW); // healthy now → recovered

    expect(store.rows[0].status).toBe("resolved");
    expect(store.rows[0].postmortemPath).toMatch(/^docs\/postmortems\/.*\.md$/);
    expect(postmortems.write).toHaveBeenCalledTimes(1);
    const [path, md] = postmortems.write.mock.calls[0];
    expect(path).toMatch(/docs\/postmortems\//);
    expect(md).toContain("# Postmortem");
  });

  it("opens the incident even when no triage target exists (degrades, still durable)", async () => {
    const down: ServiceSignal = { ...healthy, windowErrors: 900 };
    const { engine, store, triage } = makeEngine({ triageTargetNull: true });
    await engine.tickWorkspace("ws-1", new Map([["api", down]]), NOW);
    expect(store.rows.find((r) => r.sloKind === "availability")).toBeTruthy();
    expect(triage.launch).not.toHaveBeenCalled();
  });
});
