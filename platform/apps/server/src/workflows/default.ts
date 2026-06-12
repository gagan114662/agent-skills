import { loadConfig } from "../config/loader.js";
import { resolveWorkflowCaps } from "./caps.js";
import { WorkflowEngine, type WorkflowLauncher } from "./engine.js";
import { buildCatalogFacts } from "./facts.js";
import { workflowStore } from "../db/repositories/workflows.js";
import { listCatalogEntries } from "../db/repositories/catalog.js";
import { getPersonaByHandle } from "../db/repositories/personas.js";
import { getControls } from "../db/repositories/autonomy.js";
import { getWorkspaceOwnerContact } from "../db/repositories/reliability.js";
import { createRequest } from "../db/repositories/approvals.js";
import { buildMarketingSend, isMarketingSendKind } from "../marketing/external-send.js";
import { createVentureAdmission } from "../venture/default.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { notify } from "../notifications/service.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";
import type { FailureEvent } from "../flywheel/types.js";

/**
 * Production wiring for the Workflow builder (#152, ADR-0152). Default-OFF (config `workflows.enabled` +
 * `WORKFLOWS_INTERVAL_MS`), so wiring it changes nothing until an owner opts in and enables a workflow.
 * Every action seam is bound to an EXISTING gated path:
 *  - `agent_task`   → the SAME #123 venture-gated launcher automations + @mentions use (draft-only).
 *  - `draft_send`   → a PENDING #13 approval via `createRequest` (sensitive-by-default; no egress).
 *  - `notify_owner` → the #8 notification service, to the workspace owner (earliest human member).
 * No new launch authority, no new egress.
 */

/** A launcher that clears the #96 venture gate before launching through the #25 manager (the #123 path). */
function ventureGatedLauncher(sessionManager: SessionManager): WorkflowLauncher {
  const gate = createVentureAdmission();
  return {
    launch: async (input) => {
      await gate.check(input.workspaceId);
      return sessionManager.launch(input);
    },
  };
}

export function createDefaultWorkflowEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
  flywheelRecord?: (event: FailureEvent) => Promise<unknown>,
): WorkflowEngine {
  return new WorkflowEngine({
    store: workflowStore,
    launcher: ventureGatedLauncher(sessionManager),
    draftSendGate: {
      submit: async (input) => {
        if (!isMarketingSendKind(input.sendKind)) {
          throw new Error(`unknown send kind: ${input.sendKind}`);
        }
        const descriptor = buildMarketingSend({
          kind: input.sendKind,
          summary: input.summary,
          target: input.target,
          amountCents: input.amountCents,
        });
        // external.send is sensitive-by-default (#13) — always a PENDING human gate, never an egress.
        const req = await createRequest({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          actionType: descriptor.actionType,
          payload: descriptor.payload,
          amount: descriptor.amount,
          summary: input.summary,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested", detail: { source: "workflow", ...descriptor.payload } }],
        });
        return { approvalRequestId: req.id };
      },
    },
    notifier: {
      notifyOwner: async (input) => {
        const owner = await getWorkspaceOwnerContact(input.workspaceId);
        if (!owner) return { id: "" };
        const n = await notify(logger as never, {
          workspaceId: input.workspaceId,
          recipientMemberId: owner.memberId,
          type: "assignment",
          actorMemberId: null,
          excerpt: input.message,
        });
        return { id: n?.id ?? "" };
      },
    },
    resolveAgentMember: async (workspaceId, handle) => {
      const persona = await getPersonaByHandle(workspaceId, handle);
      return persona ? { agentMemberId: persona.agentMemberId } : null;
    },
    resolveFacts: async (workflow) => {
      const entries = await listCatalogEntries(workflow.workspaceId);
      return buildCatalogFacts(entries);
    },
    caps: (workspaceId) => resolveWorkflowCaps(loadConfig(workspaceId).workflows),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    flywheelRecord,
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
