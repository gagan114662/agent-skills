import type { RemediationStore } from "./engine.js";
import type { HealthSignal, RemediationRecord } from "./types.js";

/**
 * Agent-session SPAWN-failure → self-healing ops incident (#238).
 *
 * The #193 self-healing loop only ever opened incidents from its periodic HTTP probe of live deployment
 * URLs (default OFF), so a cluster of agent sessions dying at SPAWN ("exit n/a") never reached the
 * `self_healing_remediations` table — the founder-console `selfHealingOps` pane read 0 even while 21
 * real sessions had failed (the #166/#230/#238 gap). This module is the missing producer: the existing
 * `onSessionFailure` chokepoint (which already fingerprints every spawn/error/timeout into the #117
 * flywheel) now ALSO opens/dedups a self-healing incident, so the spawn cluster surfaces as a real,
 * trackable, auto-escalating incident.
 *
 * Pure over the {@link RemediationStore} seam (no IO of its own), so it unit-tests with a fake store and
 * the production path passes the `selfHealingStore` singleton. Dedup mirrors the engine's own invariant:
 * one open incident per `(workspace, surfaceKey, signal)`.
 */

/** The stable surface a spawn cluster collapses into — one incident per workspace agent fleet. */
export const AGENT_RUNTIME_SURFACE_KEY = "agent-runtime";

/**
 * A spawn failure maps onto the `stuck_agent` signal: an agent that can't even start isn't making
 * progress. This keeps `uptime`/`error_rate` meaning "the live deployment URL" (the probe's domain) and
 * never collides with a probe-opened incident (different surfaceKey).
 */
export const SPAWN_INCIDENT_SIGNAL: HealthSignal = "stuck_agent";

/**
 * Spawn failures in the open incident before it ESCALATES (the console's red dot). A missing image tool /
 * non-writable workspace root can't be auto-remediated — only an operator redeploy fixes it — so a
 * sustained cluster must escalate to a human rather than spin a doomed auto-fix.
 */
export const SPAWN_ESCALATE_THRESHOLD = 3;

export interface SpawnIncidentInput {
  workspaceId: string;
  /** Short, non-secret incident detail (a reason class + headline — never raw output). */
  detail: string;
  now: Date;
}

/**
 * Open — or bump + (past the threshold) escalate — the agent-runtime spawn incident for a workspace.
 * The first failure opens a `firing` incident; each subsequent failure increments the count (tracked on
 * `attempts`, the only writable counter on the row); once it crosses {@link SPAWN_ESCALATE_THRESHOLD} the
 * incident flips to `escalated`. Idempotent: re-detection reuses the one open row. Returns the record.
 */
export async function recordSpawnFailureIncident(
  store: RemediationStore,
  input: SpawnIncidentInput,
): Promise<RemediationRecord> {
  const existing = await store.getOpen(input.workspaceId, AGENT_RUNTIME_SURFACE_KEY, SPAWN_INCIDENT_SIGNAL);
  if (!existing) {
    return store.open({
      workspaceId: input.workspaceId,
      surfaceKey: AGENT_RUNTIME_SURFACE_KEY,
      signal: SPAWN_INCIDENT_SIGNAL,
      observedValue: 1,
      thresholdValue: SPAWN_ESCALATE_THRESHOLD,
      now: input.now,
    });
  }
  const count = existing.attempts + 1;
  const status: RemediationRecord["status"] =
    count >= SPAWN_ESCALATE_THRESHOLD && existing.status === "firing" ? "escalated" : existing.status;
  await store.update(existing.id, { attempts: count, status, detail: input.detail }, input.now);
  return { ...existing, attempts: count, status, detail: input.detail, lastActionAt: input.now };
}

/**
 * Resolve the open agent-runtime spawn incident for a workspace, if any — called when a session SUCCEEDS
 * again, the production-grounded proof the runtime recovered (the image was patched/redeployed). Returns
 * true when an incident was resolved. No-op (false) when none is open, so it's safe to call every success.
 */
export async function resolveSpawnFailureIncident(
  store: RemediationStore,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const existing = await store.getOpen(workspaceId, AGENT_RUNTIME_SURFACE_KEY, SPAWN_INCIDENT_SIGNAL);
  if (!existing) return false;
  await store.resolve(existing.id, now);
  return true;
}
