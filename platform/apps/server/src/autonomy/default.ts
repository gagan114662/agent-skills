import { channelPoster } from "../runtime/default.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";
import { getAgentSessionStatus } from "../db/repositories/agent-sessions.js";
import { listPolicyRulesWithId } from "../db/repositories/approvals.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { LoopFailureRecorder } from "../observability/loop-failures.js";
import { AutonomyEngine, type AutonomyLauncher } from "./engine.js";

/**
 * Adapt the #25 {@link SessionManager} into the engine's {@link AutonomyLauncher} seam (#84):
 * `launch`/`join` come straight off the manager; `status` reads the finalized session row so the
 * engine can feed completion/failure back into the task. A session that vanished reads as `failed`
 * (fail-safe → the task blocks for review rather than hanging "in progress" forever).
 */
export function autonomyLauncherFrom(sessionManager: SessionManager): AutonomyLauncher {
  return {
    // #248: autonomy/watchdog-revival launches surface completion through the engine's own settler
    // (createApproval + task→done), so opt OUT of the SessionManager deliverable card — otherwise every
    // workflow stage would also raise an APPROVAL NEEDED review card (double-surfacing).
    launch: (input) => sessionManager.launch({ ...input, surfaceDeliverable: false }),
    join: (id) => sessionManager.join(id),
    status: async (id) => (await getAgentSessionStatus(id)) ?? "failed",
  };
}

/**
 * Build the production AutonomyEngine (#17). It reuses the #25 channel poster (persist + realtime
 * publish), so an autonomous agent's narration is both live and persisted. When a SessionManager is
 * supplied (production), a `start`/`handoff` launches a real agent session through it (#84). A
 * completed final stage consults the workspace's `autonomy.complete` policy via the #13
 * `approval_policies` store (#84 follow-up, ADR-0042): an explicit auto-approve rule closes the
 * workflow without a human, otherwise the approval gate holds. The periodic timer is started
 * separately (and only when `AUTONOMY_INTERVAL_MS > 0`) so tests can drive `tick()`.
 */
export function createDefaultAutonomyEngine(
  logger: SessionLogger,
  sessionManager?: SessionManager,
  launcher?: AutonomyLauncher,
  failureRecorder?: LoopFailureRecorder,
): AutonomyEngine {
  return new AutonomyEngine({
    poster: channelPoster,
    logger,
    // An explicit launcher (e.g. the #96 venture-gated one composed in app.ts) wins; otherwise derive
    // it from the SessionManager (#84). Absent both → narration-only (the pre-#84 behaviour).
    launcher: launcher ?? (sessionManager ? autonomyLauncherFrom(sessionManager) : undefined),
    completionPolicies: (workspaceId) => listPolicyRulesWithId(workspaceId),
    // #99: pause the loop while the platform is in maintenance (same Redis flag the write-gate reads).
    maintenancePaused: () => isMaintenanceActive(),
    failureRecorder,
  });
}
