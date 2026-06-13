import { describe, it, expect, beforeEach } from "vitest";
import {
  SelfHealingEngine,
  type RemediationApprover,
  type RemediationLauncher,
  type RemediationStore,
  type RemediationTarget,
} from "../../src/self-healing/engine.js";
import { resetMetrics, renderMetrics } from "../../src/observability/metrics.js";
import { resolveSelfHealingCaps, type SelfHealingCaps } from "../../src/self-healing/caps.js";
import { newId } from "../../src/db/id.js";
import type { PostmortemReporter, OpsPostmortem } from "../../src/self-healing/reporter.js";
import type {
  HealthSignal,
  RemediationRecord,
  VentureHealth,
  VentureSurface,
} from "../../src/self-healing/types.js";

const silentLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
} as const;

const WS = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-06-13T03:00:00Z");

/** In-memory store implementing the engine seam, for assertions. */
function memStore(): RemediationStore & { rows: RemediationRecord[] } {
  const rows: RemediationRecord[] = [];
  const keyOf = (ws: string, vk: string, sig: HealthSignal) => `${ws}|${vk}|${sig}`;
  return {
    rows,
    async getOpen(ws, vk, sig) {
      return (
        rows.find(
          (r) => r.status !== "resolved" && keyOf(r.workspaceId, r.surfaceKey, r.signal) === keyOf(ws, vk, sig),
        ) ?? null
      );
    },
    async open(input) {
      const row: RemediationRecord = {
        id: newId(),
        workspaceId: input.workspaceId,
        surfaceKey: input.surfaceKey,
        signal: input.signal,
        status: "firing",
        action: null,
        reversibility: null,
        requiresApproval: true,
        approvalRequestId: null,
        remediationSessionId: null,
        attempts: 0,
        observedValue: input.observedValue,
        thresholdValue: input.thresholdValue,
        detail: null,
        postmortemIssueRef: null,
        openedAt: input.now,
        lastActionAt: input.now,
        resolvedAt: null,
      };
      rows.push(row);
      return row;
    },
    async update(id, patch, now) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      Object.assign(row, patch, { lastActionAt: now });
    },
    async resolve(id, now) {
      const row = rows.find((r) => r.id === id)!;
      row.status = "resolved";
      row.resolvedAt = now;
      return row;
    },
    async listOpen(ws) {
      return rows.filter((r) => r.workspaceId === ws && r.status !== "resolved");
    },
  };
}

function caps(over: Partial<SelfHealingCaps> = {}): SelfHealingCaps {
  return { ...resolveSelfHealingCaps({ enabled: true, autoRemediate: true }), ...over };
}

interface Harness {
  store: ReturnType<typeof memStore>;
  launches: number;
  approvals: number;
  postmortems: OpsPostmortem[];
  setHealth: (h: VentureHealth) => void;
  engine: SelfHealingEngine;
}

function harness(opts: {
  caps: SelfHealingCaps;
  health: VentureHealth;
  killSwitch?: boolean;
  correlatedDeployId?: string | null;
  hasTarget?: boolean;
}): Harness {
  const store = memStore();
  const state = { launches: 0, approvals: 0, postmortems: [] as OpsPostmortem[], health: opts.health };

  const launcher: RemediationLauncher = {
    launch: async () => {
      state.launches += 1;
      return { id: newId() };
    },
  };
  const target: RemediationTarget = {
    resolve: async () =>
      opts.hasTarget === false
        ? null
        : { channelId: newId(), agentMemberId: newId(), createdByMemberId: newId() },
  };
  const approver: RemediationApprover = {
    enqueue: async () => {
      state.approvals += 1;
      return { id: newId() };
    },
  };
  const reporter: PostmortemReporter = {
    report: async (pm) => {
      state.postmortems.push(pm);
      return { action: "recorded" };
    },
  };
  const surfaces: VentureSurface[] = [{ surfaceKey: "venture-a", label: "Venture A" }];

  const engine = new SelfHealingEngine({
    listWorkspaceIds: async () => [WS],
    caps: () => opts.caps,
    killSwitch: async () => opts.killSwitch ?? false,
    surfaces: async () => surfaces,
    probe: async () => state.health,
    correlateDeploy: async () => opts.correlatedDeployId ?? null,
    store,
    launcher,
    target,
    approver,
    reporters: async () => [reporter],
    logger: silentLogger,
    now: () => NOW,
  });

  return {
    store,
    get launches() {
      return state.launches;
    },
    get approvals() {
      return state.approvals;
    },
    postmortems: state.postmortems,
    setHealth: (hh: VentureHealth) => {
      state.health = hh;
    },
    engine,
  };
}

const healthy: VentureHealth = { reachable: true, errorRate: 0, queueDepth: 0, stuckAgents: 0 };
const down: VentureHealth = { reachable: false, errorRate: null, queueDepth: null, stuckAgents: 0 };

describe("SelfHealingEngine (#193)", () => {
  beforeEach(() => resetMetrics());

  it("disabled workspace is skipped (default-OFF)", async () => {
    const h = harness({ caps: resolveSelfHealingCaps(undefined), health: down });
    const res = await h.engine.tickWorkspace(WS, NOW);
    expect(res.skipped).toBe("disabled");
    expect(h.store.rows).toHaveLength(0);
  });

  it("kill switch halts the pass", async () => {
    const h = harness({ caps: caps(), health: down, killSwitch: true });
    const res = await h.engine.tickWorkspace(WS, NOW);
    expect(res.skipped).toBe("kill_switch");
  });

  it("healthy surface opens no incident", async () => {
    const h = harness({ caps: caps(), health: healthy });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.store.rows).toHaveLength(0);
  });

  it("uptime breach ⇒ restart session dispatched, status remediating, attempts=1 (AC2)", async () => {
    const h = harness({ caps: caps(), health: down });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.launches).toBe(1);
    const row = h.store.rows[0]!;
    expect(row).toMatchObject({ signal: "uptime", action: "restart", status: "remediating", attempts: 1 });
    expect(renderMetrics()).toContain('self_healing_actions_total{action="restart"}');
  });

  it("retry-once-then-escalate: a second tick still down ⇒ escalate + postmortem filed (AC3/AC4)", async () => {
    const h = harness({ caps: caps(), health: down });
    await h.engine.tickWorkspace(WS, NOW); // attempt 1 → restart
    await h.engine.tickWorkspace(WS, NOW); // attempts==1==max → escalate
    const row = h.store.rows[0]!;
    expect(row.status).toBe("escalated");
    expect(h.approvals).toBe(1);
    expect(h.postmortems).toHaveLength(1);
    expect(h.postmortems[0]).toMatchObject({ signal: "uptime", missingCheck: expect.stringContaining("liveness probe") });
  });

  it("recovery resolves the open incident", async () => {
    const h = harness({ caps: caps(), health: down });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.store.rows[0]!.status).toBe("remediating");
    h.setHealth(healthy);
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.store.rows[0]!.status).toBe("resolved");
  });

  it("autoRemediate OFF ⇒ breach only escalates (no session), files a postmortem", async () => {
    const h = harness({ caps: caps({ autoRemediate: false }), health: down });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.launches).toBe(0);
    expect(h.approvals).toBe(1);
    expect(h.store.rows[0]!.status).toBe("escalated");
    expect(h.postmortems).toHaveLength(1);
  });

  it("destructive rollback (gated) ⇒ #13 approval, NO session, NO postmortem (gated remediation, not a failure)", async () => {
    const h = harness({
      caps: caps({ allowRollback: true }),
      health: { reachable: false, errorRate: null, queueDepth: null, stuckAgents: 0 },
      correlatedDeployId: "dep-9",
    });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.approvals).toBe(1);
    expect(h.launches).toBe(0);
    expect(h.postmortems).toHaveLength(0);
    expect(h.store.rows[0]!).toMatchObject({ action: "rollback", status: "escalated", requiresApproval: true });
  });

  it("pre-committed rollback ⇒ dispatched as a session (no approval gate)", async () => {
    const h = harness({
      caps: caps({ allowRollback: true, preCommitRollback: true }),
      health: { reachable: false, errorRate: null, queueDepth: null, stuckAgents: 0 },
      correlatedDeployId: "dep-9",
    });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.launches).toBe(1);
    expect(h.approvals).toBe(0);
    expect(h.store.rows[0]!).toMatchObject({ action: "rollback", status: "remediating", requiresApproval: false });
  });

  it("queue_depth + scale allowed ⇒ gated scale approval", async () => {
    const h = harness({
      caps: caps({ allowScale: true }),
      health: { reachable: true, errorRate: 0, queueDepth: 500, stuckAgents: 0 },
    });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.approvals).toBe(1);
    expect(h.store.rows[0]!).toMatchObject({ signal: "queue_depth", action: "scale_up", status: "escalated" });
  });

  it("no channel/agent target ⇒ restart is decided but no session launches (still tracked)", async () => {
    const h = harness({ caps: caps(), health: down, hasTarget: false });
    await h.engine.tickWorkspace(WS, NOW);
    expect(h.launches).toBe(0);
    expect(h.store.rows[0]!).toMatchObject({ action: "restart", status: "remediating" });
  });
});
