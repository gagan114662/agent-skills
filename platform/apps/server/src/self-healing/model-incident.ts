import type { RemediationStore } from "./engine.js";
import type { HealthSignal, RemediationRecord } from "./types.js";

/**
 * Agent-session MODEL-misconfiguration → self-healing ops incident (#242).
 *
 * Sibling to {@link file://./spawn-incident.ts} (#238): where a SPAWN cluster means "the agent can't even
 * start", a MODEL cluster means "the agent starts but every run dies because the deployment (or a #52
 * selection) pinned a `--model` the API can't serve" — the exact prod cause of "error · exit 1" after
 * `ANTHROPIC_MODEL=claude-fable-5` (a non-existent model) was set deployment-wide: claude `-p` exited 1
 * having produced nothing, so a briefed task never produced an artifact.
 *
 * Unlike a spawn (only an operator redeploy fixes a missing image tool), a model misconfig is a CONFIG
 * value the owner controls — so this opens a trackable, escalating incident the founder console surfaces
 * (`selfHealingOps`) AND it is NOT routed to the #117 auto-fix flywheel (a fix agent can't change a
 * deployment's `--model`). It resolves on the next clean session — the production-grounded proof the
 * model was corrected/redeployed — exactly the spawn-incident self-heal loop.
 *
 * Pure over the {@link RemediationStore} seam (no IO of its own): unit-tested with a fake store, the
 * production path passes the `selfHealingStore` singleton. Dedup mirrors the engine's invariant: one open
 * incident per `(workspace, surfaceKey, signal)`. A DISTINCT `surfaceKey` keeps it from colliding with a
 * spawn incident (same `stuck_agent` signal, different surface).
 */

/** The stable surface a model-misconfig cluster collapses into — one incident per workspace agent fleet. */
export const AGENT_MODEL_SURFACE_KEY = "agent-model";

/**
 * A model misconfig maps onto the `stuck_agent` signal: an agent whose every run dies on a bad model isn't
 * making progress. The distinct {@link AGENT_MODEL_SURFACE_KEY} keeps `uptime`/`error_rate` meaning "the
 * live deployment URL" (the probe's domain) and never collides with a probe- or spawn-opened incident.
 */
export const MODEL_INCIDENT_SIGNAL: HealthSignal = "stuck_agent";

/**
 * Model failures in the open incident before it ESCALATES (the console's red dot). A bad `--model` can't
 * be auto-remediated — only the owner picking a valid model / a redeploy fixes it — so a sustained cluster
 * must escalate to a human rather than spin a doomed auto-fix.
 */
export const MODEL_ESCALATE_THRESHOLD = 3;

export interface ModelIncidentInput {
  workspaceId: string;
  /** Short, non-secret incident detail (a reason class + headline + redacted excerpt — never raw output). */
  detail: string;
  now: Date;
}

/**
 * Open — or bump + (past the threshold) escalate — the agent-model misconfig incident for a workspace.
 * The first failure opens a `firing` incident; each subsequent failure increments the count (tracked on
 * `attempts`, the only writable counter on the row); once it crosses {@link MODEL_ESCALATE_THRESHOLD} the
 * incident flips to `escalated`. Idempotent: re-detection reuses the one open row. Returns the record.
 */
export async function recordModelFailureIncident(
  store: RemediationStore,
  input: ModelIncidentInput,
): Promise<RemediationRecord> {
  const existing = await store.getOpen(input.workspaceId, AGENT_MODEL_SURFACE_KEY, MODEL_INCIDENT_SIGNAL);
  if (!existing) {
    const opened = await store.open({
      workspaceId: input.workspaceId,
      surfaceKey: AGENT_MODEL_SURFACE_KEY,
      signal: MODEL_INCIDENT_SIGNAL,
      observedValue: 1,
      thresholdValue: MODEL_ESCALATE_THRESHOLD,
      now: input.now,
    });
    // `store.open` has no `detail` field, so set the real cause on the freshly-opened row — the console's
    // ops pane names the unavailable model from the very first failure, not only after a second one bumps it.
    await store.update(opened.id, { detail: input.detail }, input.now);
    return { ...opened, detail: input.detail };
  }
  const count = existing.attempts + 1;
  const status: RemediationRecord["status"] =
    count >= MODEL_ESCALATE_THRESHOLD && existing.status === "firing" ? "escalated" : existing.status;
  await store.update(existing.id, { attempts: count, status, detail: input.detail }, input.now);
  return { ...existing, attempts: count, status, detail: input.detail, lastActionAt: input.now };
}

/**
 * Resolve the open agent-model incident for a workspace, if any — called when a session SUCCEEDS again,
 * the production-grounded proof the model was corrected (a valid model selected / the deployment
 * redeployed). Returns true when an incident was resolved. No-op (false) when none is open, so it's safe
 * to call on every success.
 */
export async function resolveModelFailureIncident(
  store: RemediationStore,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const existing = await store.getOpen(workspaceId, AGENT_MODEL_SURFACE_KEY, MODEL_INCIDENT_SIGNAL);
  if (!existing) return false;
  await store.resolve(existing.id, now);
  return true;
}
