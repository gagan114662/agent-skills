import { describe, it, expect } from "vitest";
import type { RemediationStore } from "../../src/self-healing/engine.js";
import type { RemediationRecord } from "../../src/self-healing/types.js";
import {
  recordModelFailureIncident,
  resolveModelFailureIncident,
  AGENT_MODEL_SURFACE_KEY,
  MODEL_INCIDENT_SIGNAL,
  MODEL_ESCALATE_THRESHOLD,
} from "../../src/self-healing/model-incident.js";
import {
  recordSpawnFailureIncident,
  AGENT_RUNTIME_SURFACE_KEY,
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
const detail = "The model this workspace is set to use isn't available — ⚠️ selected model (claude-fable-5)";

describe("model-incident (#242 — agent model misconfig → self-healing ops incident)", () => {
  it("opens ONE firing incident on the agent-model/stuck_agent surface on the first model failure", async () => {
    const store = fakeStore();
    const rec = await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    expect(rec.status).toBe("firing");
    expect(rec.surfaceKey).toBe(AGENT_MODEL_SURFACE_KEY);
    expect(rec.signal).toBe(MODEL_INCIDENT_SIGNAL);
    expect(rec.detail).toContain("claude-fable-5"); // the real cause is carried, not just a generic headline
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(1);
  });

  it("dedups: repeated model failures reuse the one open incident (no duplicate rows)", async () => {
    const store = fakeStore();
    await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.attempts).toBe(1);
  });

  it("escalates once the cluster crosses the threshold (a human must pick a valid model)", async () => {
    const store = fakeStore();
    let rec = await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    for (let i = 0; i < MODEL_ESCALATE_THRESHOLD; i++) {
      rec = await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    }
    expect(rec.status).toBe("escalated");
  });

  it("resolves on the next successful session (the model was corrected); no-op when none open", async () => {
    const store = fakeStore();
    expect(await resolveModelFailureIncident(store, "ws1", now)).toBe(false);
    await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    expect(await resolveModelFailureIncident(store, "ws1", now)).toBe(true);
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(0);
  });

  it("does NOT collide with a spawn incident — distinct surfaces can be open at once", async () => {
    const store = fakeStore();
    await recordSpawnFailureIncident(store, { workspaceId: "ws1", detail: "missing tool", now });
    await recordModelFailureIncident(store, { workspaceId: "ws1", detail, now });
    const open = store.rows.filter((r) => r.status !== "resolved");
    expect(open).toHaveLength(2);
    expect(open.map((r) => r.surfaceKey).sort()).toEqual(
      [AGENT_MODEL_SURFACE_KEY, AGENT_RUNTIME_SURFACE_KEY].sort(),
    );
    // resolving the model incident leaves the spawn incident untouched.
    await resolveModelFailureIncident(store, "ws1", now);
    expect(store.rows.filter((r) => r.status !== "resolved")).toHaveLength(1);
  });
});
