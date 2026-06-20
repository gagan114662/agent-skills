/**
 * Production wiring for the Agent Registry + A2A surface (#282, ADR-0282). Binds the pure registry/A2A
 * decision to the real seams: per-workspace caps from the layered config (#58), the present handles from
 * the seeded personas (#123), and — crucially — the A2A `dispatch` to the EXISTING #235 brief front door,
 * so an allowed call launches the target down the audited @mention path (#68 → #59 SubagentService → #96
 * venture gate → #71 admission). No new launch authority: this is a thin front door, exactly like brief.ts.
 *
 * Observability: the brief dispatch posts `@target <task>` and writes a durable `marketing_tasks` receipt
 * (read back by the #-audit feed), and the service returns the {@link A2ACallRecord} for the hop — so the
 * call path is observable both live (the record) and durably (the message + receipt), with no new store.
 */
import type { SessionManager } from "../runtime/manager.js";
import { listPersonas } from "../db/repositories/personas.js";
import { loadConfig } from "../config/loader.js";
import { createMarketingBriefService } from "../marketing/default.js";
import type { MarketingBriefResult } from "../marketing/brief.js";
import { resolveAgentRegistryCaps } from "./caps.js";
import { encodeHandoffGoal } from "./handoff.js";
import {
  AgentRegistryService,
  type AgentRegistryDeps,
  type AgentRegistryIdentity,
  type DispatchResult,
} from "./service.js";

/** The slice of the #235 brief front door the a2a dispatch needs — injectable so the wiring is testable. */
export interface A2ADispatchBrief {
  brief(
    identity: { workspaceId: string; memberId: string },
    input: { lead: string; goal: string; systemAuthorized?: boolean },
  ): Promise<MarketingBriefResult>;
}

/**
 * Build the A2A `dispatch` seam over a brief front door (#282/#417). Exported (and brief-injected) so the
 * wiring is unit-testable without a DB or SessionManager. It posts `@target <task>` and launches the target
 * down the audited brief path — but as a GOVERNED agent→agent handoff: {@link decideA2ACall} already
 * authorized the hop, so it sets `systemAuthorized: true` to skip the human #9 channel-RBAC head (the
 * caller agent isn't a `propagate` member of the target's channel). The venture/admission gate inside the
 * launcher still runs — `systemAuthorized` grants no new authority.
 */
export function buildA2ADispatch(brief: A2ADispatchBrief): AgentRegistryDeps["dispatch"] {
  return async (identity: AgentRegistryIdentity, input): Promise<DispatchResult> => {
    // The chain marker (#417) lets the launched session carry the a2a call chain to the next hop, so a
    // multi-hop deliverable handoff stays depth/cycle-bounded. An empty chain returns the goal unchanged
    // → byte-identical to today's manual a2a route. The marker is OUR structural prefix on the task we
    // assign; it is never read from agent free output (#200).
    const goal = encodeHandoffGoal(
      input.callChain,
      `[A2A handoff from @${input.callerHandle}] ${input.task}`,
    );
    const result = await brief.brief(
      { workspaceId: identity.workspaceId, memberId: identity.memberId },
      // #417: a governed a2a handoff — decideA2ACall authorized the call out-of-band, so the brief launches
      // through the #59 gate WITHOUT the human channel-RBAC head (the caller agent can't satisfy it).
      { lead: input.targetHandle, goal, systemAuthorized: true },
    );
    if (!result.ok) return { ok: false, code: result.code, error: result.error };
    return {
      ok: true,
      channelId: result.channelId,
      messageId: result.messageId,
      sessionId: result.launched[0]?.sessionId ?? null,
    };
  };
}

/**
 * Build the Agent Registry service over the real repos + the venture-gated brief launcher. The `dispatch`
 * seam hands an allowed A2A call to the brief service: it posts `@<target> <task>` AS the calling member
 * and launches the target through the existing audited path. The caller attribution is a STRUCTURAL prefix
 * (built from the already-validated caller @handle) so the durable receipt shows the hop; it is data the
 * target reads, never instructions that widen its scope (injection defense, ADR-0282).
 */
export function createAgentRegistryService(sessionManager: SessionManager): AgentRegistryService {
  const brief = createMarketingBriefService(sessionManager);
  return new AgentRegistryService({
    caps: (workspaceId) => resolveAgentRegistryCaps(loadConfig(workspaceId).agentRegistry),
    listPresentHandles: async (workspaceId) => (await listPersonas(workspaceId)).map((p) => p.name),
    dispatch: buildA2ADispatch(brief),
  });
}
