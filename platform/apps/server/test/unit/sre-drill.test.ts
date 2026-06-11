import { describe, it, expect, beforeEach, vi } from "vitest";
import { chaosSignals, runChaosDrill } from "../../src/sre/drill.js";
import { SreEngine, type SreIncidentStore } from "../../src/sre/engine.js";
import { resetMetrics } from "../../src/observability/metrics.js";
import { newId } from "../../src/db/id.js";
import type { SreCaps } from "../../src/sre/caps.js";
import type { IncidentRecord } from "../../src/sre/types.js";

const silentLogger = { child: () => silentLogger, info: () => {}, warn: () => {}, error: () => {} } as const;
const NOW = new Date("2026-06-10T12:00:00Z");

function memStore(): SreIncidentStore {
  const rows: IncidentRecord[] = [];
  return {
    async getOpen() {
      return null;
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
    async attachTriage() {},
    async markEscalated() {},
    async recordNotified() {},
    async resolve(input) {
      return rows.find((r) => r.id === input.id)!;
    },
  };
}

const caps: SreCaps = {
  enabled: true,
  cooldownMs: 60_000,
  services: [
    { service: "api", targets: [{ kind: "availability", target: 0.99 }, { kind: "latency_p95", target: 500 }] },
    { service: "redis", targets: [{ kind: "availability", target: 1 }] },
  ],
};

beforeEach(() => resetMetrics());

describe("chaosSignals", () => {
  it("produces a Redis-down + PG-down + api-erroring signal set", () => {
    const s = chaosSignals();
    expect(s.get("redis")!.healthy).toBe(false);
    expect(s.get("db")!.healthy).toBe(false);
    expect(s.get("api")!.windowErrors).toBeGreaterThan(0);
  });
});

describe("runChaosDrill", () => {
  function build() {
    const triage = { launch: vi.fn(async () => ({ id: `t-${newId()}` })) };
    const engine = new SreEngine({
      readSignals: async () => new Map(),
      listWorkspaceIds: async () => ["ws-1"],
      caps: () => caps,
      killSwitch: async () => false,
      incidents: memStore(),
      triage,
      triageTarget: { resolve: async () => ({ channelId: "c", agentMemberId: "a", createdByMemberId: "a" }) },
      bundle: { context: async () => ({ recentDeploys: [], traceHints: [], runbookLinks: [] }) },
      escalator: { escalate: async () => ({ id: "e" }) },
      notifier: { notify: async () => {} },
      postmortems: { write: async () => {} },
      logger: silentLogger,
      now: () => NOW,
    });
    return { engine, triage };
  }

  it("passes: injected chaos opens incidents and launches triage", async () => {
    const { engine, triage } = build();
    const result = await runChaosDrill({
      engine,
      workspaceId: "ws-1",
      signals: chaosSignals(),
      now: NOW,
      launchCount: () => triage.launch.mock.calls.length,
    });
    expect(result.ok).toBe(true);
    expect(result.incidentsOpened).toBeGreaterThan(0);
    expect(result.triageLaunches).toBeGreaterThan(0);
  });

  it("fails loudly when no incident fires (the alert pipeline is broken)", async () => {
    const { engine, triage } = build();
    const healthy = new Map([
      ["api", { service: "api", windowRequests: 1000, windowErrors: 0, p95LatencyMs: 100, queueLagSeconds: 0, healthy: true }],
      ["redis", { service: "redis", windowRequests: 0, windowErrors: 0, p95LatencyMs: 0, queueLagSeconds: 0, healthy: true }],
    ]);
    const result = await runChaosDrill({
      engine,
      workspaceId: "ws-1",
      signals: healthy,
      now: NOW,
      launchCount: () => triage.launch.mock.calls.length,
    });
    expect(result.ok).toBe(false);
    expect(result.incidentsOpened).toBe(0);
  });
});
