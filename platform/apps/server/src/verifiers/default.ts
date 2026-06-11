import { loadConfig } from "../config/loader.js";
import { makeRedactor } from "../runtime/redact.js";
import { resolveVerifierCaps } from "./caps.js";
import {
  VerifierRunner,
  type ObservationSource,
  type VerifierClaimSource,
  type VerifierEscalator,
} from "./engine.js";
import type { Observation, ObservationError, VerifierClaim } from "./types.js";
import { verifierResultStore } from "../db/repositories/verifier-results.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { listLiveSessions } from "../db/repositories/agent-sessions.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { SessionLogger } from "../runtime/manager.js";

/**
 * Production wiring for Outcome Verifiers (#106, ADR-0106). Default-OFF (config `verifiers.enabled` +
 * `VERIFIERS_INTERVAL_MS`), so wiring it changes nothing until an operator opts in. Every seam is real:
 * the durable store is the `verifier_results` repo, escalation is the #13 queue, the kill switch is the
 * #17 control, and the maintenance gate is the #99 flag.
 *
 * The observation source ships a real `deploy_live` HTTP probe (it treats the claim's `claimRef` as the
 * live URL); the `revenue_real` / `growth_metric` / `fix_held` probes are wired by their owning
 * subsystems (#98 / metrics / #117) as additive follow-up — until then they record `errored`, never a
 * false verdict. The due-claim source is empty by default (claim producers are additive), so the
 * production tick is a no-op until a deployment opts in and a producer enqueues claims.
 */

/** A real HTTP probe for `deploy_live`: GET the URL, treat 2xx as healthy. Transport error ⇒ errored. */
async function probeDeployLive(claim: VerifierClaim): Promise<Observation | ObservationError> {
  const url = claim.claimRef;
  if (!/^https?:\/\//.test(url)) {
    return { kind: "deploy_live", errored: true, reason: `claimRef is not an http(s) url: ${url}` };
  }
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    return { kind: "deploy_live", httpStatus: res.status, healthy: res.ok };
  } catch (err) {
    return {
      kind: "deploy_live",
      errored: true,
      reason: err instanceof Error ? err.message : "deploy probe failed",
    };
  }
}

/**
 * The default observation source. `deploy_live` is a live HTTP probe; the other kinds are an explicit
 * seam (record `errored` with a clear reason) until their owning subsystem wires a real probe.
 */
export const defaultObservationSource: ObservationSource = {
  observe: async (claim) => {
    if (claim.kind === "deploy_live") return probeDeployLive(claim);
    return {
      kind: claim.kind,
      errored: true,
      reason: `no observation source configured for ${claim.kind} (seam — wired by its owning subsystem)`,
    };
  },
};

/** No claim producers are wired yet — the tick is a no-op until a deployment enqueues claims. */
const emptyClaimSource: VerifierClaimSource = {
  listDue: async () => [],
};

/** #13: enqueue a human approval for a FAILED verification (the "no silent pass" rail). */
const approvalEscalator: VerifierEscalator = {
  escalate: async ({ workspaceId, claim, outcome }) => {
    // The approvals queue requires a real requester member (#13 FK). Resolve one from a live session in
    // the workspace; with none, we cannot enqueue (the runner logs it and the row still persists failed).
    const live = await listLiveSessions();
    const session = live.find((s) => s.workspaceId === workspaceId);
    if (!session) throw new Error("verifier escalate: no requester member available");
    const req = await createRequest({
      workspaceId,
      requesterMemberId: session.agentMemberId,
      actionType: "verifier.failed",
      payload: {
        kind: claim.kind,
        claimRef: claim.claimRef,
        measuredValue: outcome.measuredValue,
        threshold: outcome.threshold,
      },
      amount: null,
      summary:
        `Outcome verifier FAILED: ${claim.kind} for ${claim.claimRef} — ` +
        `${outcome.detail}. A failed gate needs a human (never silently passes).`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { kind: claim.kind, claimRef: claim.claimRef } }],
    });
    return { id: req.id };
  },
};

/** Build the production VerifierRunner. The background timer is started in `index.ts`. */
export function createDefaultVerifierRunner(logger: SessionLogger): VerifierRunner {
  const redactor = makeRedactor({});
  return new VerifierRunner({
    observations: defaultObservationSource,
    results: verifierResultStore,
    escalator: approvalEscalator,
    claims: emptyClaimSource,
    caps: (workspaceId) => resolveVerifierCaps(loadConfig(workspaceId).verifiers),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    activeWorkspaces: listWorkspaceIds,
    redact: (text) => redactor(text),
    // #99: pause the loop during maintenance (same Redis flag the write-gate + other loops read).
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
