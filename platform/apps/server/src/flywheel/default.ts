import { loadConfig } from "../config/loader.js";
import { resolveFlywheelCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import { FlywheelEngine, type FixApprovalQueue, type FixLauncher, type IssueFiler } from "./engine.js";
import { makeRedactor } from "../runtime/redact.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import {
  flywheelFingerprintStore,
  flywheelDispatchStore,
  listActiveWorkspaces,
} from "../db/repositories/flywheel.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { listPolicyRulesWithId, createRequest } from "../db/repositories/approvals.js";
import { evaluatePolicy } from "../approvals/policy.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";
import type { FailureClass } from "./types.js";

/**
 * Production wiring for the Self-Healing Flywheel (#117, ADR-0117). Default-OFF (config
 * `flywheel.enabled` + `FLYWHEEL_INTERVAL_MS`), so wiring it changes nothing until an operator opts in.
 * The issue filer defaults to a **no-op** (a synthetic ref) so CI/tests never call GitHub; a deployment
 * configures a real repo target + token to file actual issues via the #57 provider path.
 */

/** The #95 policy action a fix dispatch for a class is gated under (sensitive-by-default). */
export function flywheelFixAction(failureClass: FailureClass): string {
  return `flywheel.fix.${failureClass}`;
}

/**
 * Sensitive-by-default auto-dispatch check (#95): a fix is auto-allowed for a class ONLY when an
 * explicit workspace policy rule opts it in (a rule with `requiresApproval: false`). No rule ⇒ queue.
 */
async function autoDispatchAllowed(workspaceId: string, failureClass: FailureClass): Promise<boolean> {
  const action = flywheelFixAction(failureClass);
  const rules = await listPolicyRulesWithId(workspaceId);
  const rule = rules.find((r) => r.actionType === action);
  if (!rule) return false; // sensitive-by-default
  return !evaluatePolicy({ actionType: action }, [rule]).requiresApproval;
}

/** A no-op issue filer: returns a synthetic local ref so the loop runs without a GitHub credential. */
export function noopIssueFiler(logger: SessionLogger): IssueFiler {
  let seq = 0;
  return {
    create: async ({ title }) => {
      seq += 1;
      logger.info({ title }, "flywheel (no-op filer): would file a GitHub issue");
      return { ref: `local:flywheel#${seq}`, state: "open" };
    },
    comment: async ({ ref }) => {
      logger.info({ ref }, "flywheel (no-op filer): would comment on a GitHub issue");
    },
    reopen: async ({ ref }) => {
      logger.info({ ref }, "flywheel (no-op filer): would reopen a GitHub issue");
      return { state: "open" };
    },
  };
}

/** The #92 launcher, adapted to launch a fix agent into the fingerprint's originating channel/agent. */
function fixLauncherFrom(sessionManager: SessionManager): FixLauncher {
  const launcher = autonomyLauncherFrom(sessionManager);
  return {
    launch: async ({ workspaceId, fingerprint, task, harnessEnv }) => {
      if (!fingerprint.originChannelId || !fingerprint.originAgentMemberId) {
        // Context-less failures (CI/SLO) have no launch target — they queue for a human (who supplies
        // one). The dispatch decision should never route such a fingerprint here, but fail loud if so.
        throw new Error("flywheel: cannot auto-dispatch a fingerprint with no origin channel/agent");
      }
      return launcher.launch({
        workspaceId,
        channelId: fingerprint.originChannelId,
        agentMemberId: fingerprint.originAgentMemberId,
        createdByMemberId: fingerprint.originAgentMemberId,
        task,
        harnessEnv,
      });
    },
  };
}

/** The #13 approval queue for a fix that is not auto-allowed (surfaced in the #104 console). */
const fixApprovalQueue: FixApprovalQueue = {
  enqueue: async ({ workspaceId, fingerprint, reason }) => {
    if (!fingerprint.originAgentMemberId) {
      throw new Error("flywheel: cannot enqueue a fix approval with no origin agent member");
    }
    const req = await createRequest({
      workspaceId,
      requesterMemberId: fingerprint.originAgentMemberId,
      actionType: flywheelFixAction(fingerprint.failureClass),
      payload: { fingerprintId: fingerprint.id, signature: fingerprint.signature, issueRef: fingerprint.issueRef },
      amount: null,
      summary:
        `Flywheel fix dispatch (${reason}): ${fingerprint.title} — ${fingerprint.occurrenceCount} ` +
        `occurrence(s). Needs a human to approve launching a fix agent.`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { fingerprintId: fingerprint.id, reason } }],
    });
    return { id: req.id };
  },
};

/** Build the production FlywheelEngine. The background timer is started in `index.ts`. */
export function createDefaultFlywheelEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): FlywheelEngine {
  return new FlywheelEngine({
    fingerprints: flywheelFingerprintStore,
    dispatches: flywheelDispatchStore,
    filer: noopIssueFiler(logger),
    launcher: fixLauncherFrom(sessionManager),
    approvalQueue: fixApprovalQueue,
    caps: (workspaceId) => resolveFlywheelCaps(loadConfig(workspaceId).flywheel),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    budgetExhausted: async (workspaceId, now) =>
      budgetExceeded(
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
        resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
      ),
    autoDispatchAllowed,
    redact: (text, secrets) => makeRedactor(secrets)(text),
    activeWorkspaces: listActiveWorkspaces,
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
