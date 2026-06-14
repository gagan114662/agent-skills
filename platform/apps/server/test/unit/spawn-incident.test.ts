import { describe, it, expect } from "vitest";
import type { RemediationStore } from "../../src/self-healing/engine.js";
import type { RemediationRecord } from "../../src/self-healing/types.js";
import {
  recordSpawnFailureIncident,
  resolveSpawnFailureIncident,
  AGENT_RUNTIME_SURFACE_KEY,
  SPAWN_INCIDENT_SIGNAL,
  SPAWN_ESCALATE_THRESHOLD,
} from "../../src/self-healing/spawn-incident.js";

/** A minimal in-memory RemediationStore — one open row per (workspace, surfaceKey, signal). */
function fakeStore(): RemediationStore & { rows: RemediationRecord[] } {
  const rows: RemediationRecord[] = [];
  let seq = 0;
  return {
    rows,
    getOpen: (workspaceId, surfaceKey, signal) =>
      Promise.resolve(
        rows.find(
          (r) =>
            r.workspaceId === workspaceId &&
            r.surfaceKey === surfaceKey &&
            r.signal === signal &&
            r.status !== "resolved",
        ) ?? null,
      ),
    open: (input) => {
      const row: RemediationRecord = {
        id: `rem-${++seq}`,
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
      return Promise.resolve(row);
    },
    update: (id, patch, now) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch, { lastActionAt: now });
      return Promise.resolve();
    },
    resolve: (id, now) => {
      const row = rows.find((r) => r.id === id)!;
      row.status = "resolved";
      row.resolvedAt = now;
      return Promise.resolve(row);
    },
    listOpen: (workspaceId) =>
      Promise.resolve(rows.filter((r) => r.workspaceId === workspaceId && r.status !== "resolved")),
  };
}

const now = new Date("2026-06-14T00:00:00Z");

describe("spawn-incident (#238 — agent spawn cluster → self-healing ops incident)", () => {
  it("opens ONE firing incident on the agent-runtime/stuck_agent surface on the first spawn failure", async () => {
    const store = fakeStore();
    const rec = await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "missing tool", now });
    expect(rec.status).toBe("firing");
    expect(rec.surfaceKey).toBe(AGENT_RUNTIME_SURFACE_KEY);
    expect(rec.signal).toBe(SPAWN_INCIDENT_SIGNAL);
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(1);
  });

  it("dedups: repeated spawn failures reuse the one open incident (no duplicate rows)", async () => {
    const store = fakeStore();
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.attempts).toBe(1); // first open=0 attempts, one repeat bump
  });

  it("escalates to 'escalated' once the cluster crosses the threshold (a human must redeploy)", async () => {
    const store = fakeStore();
    let rec = await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    // first call opens (attempts 0, firing); subsequent calls bump attempts.
    for (let i = 0; i < SPAWN_ESCALATE_THRESHOLD; i++) {
      rec = await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    }
    expect(rec.status).toBe("escalated");
    expect(store.rows.filter((r) => r.status === "escalated")).toHaveLength(1);
  });

  it("keeps incidents per-workspace isolated (one tenant's cluster never touches another's)", async () => {
    const store = fakeStore();
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    await recordSpawnFailureIncident(store, { workspaceId: "ws2", detail: "x", now });
    expect(store.rows).toHaveLength(2);
  });

  it("resolves the open incident on the next successful session (recovery proof); no-op when none open", async () => {
    const store = fakeStore();
    expect(await resolveSpawnFailureIncident(store, "ws1", now)).toBe(false); // nothing open yet
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    expect(await resolveSpawnFailureIncident(store, "ws1", now)).toBe(true);
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(0);
    // a fresh failure after recovery opens a NEW incident (does not reuse the resolved one).
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "x", now });
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(1);
  });
});
