import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { SessionManager } from "../runtime/manager.js";
import { createAgentRegistryService } from "../agent-registry/default.js";

export interface AgentRegistryRoutesOptions {
  sessionManager: SessionManager;
}

/**
 * Agent Registry + A2A routes (#282, ADR-0282). Two surfaces:
 *   - `GET  /workspaces/:wid/agent-registry` — list the fleet's declared contracts (capabilities,
 *     inputs/outputs, tools, cost + risk tier) with per-workspace present/enabled flags. Read-only; works
 *     regardless of the flag (the catalog is always inspectable; `enabled` reflects the #282 feature flag).
 *   - `POST /workspaces/:wid/agent-registry/call` — run a governed, observable agent-to-agent call. The pure
 *     {@link decideA2ACall} governs it (capability + injection + bounded-autonomy checks); an allowed call
 *     dispatches down the EXISTING audited @mention launch path. A launch denial (kill switch / budget)
 *     bubbles to the app error handler (→ 402/429) exactly as the brief route does — deliberately not caught.
 *
 * Human-auth + workspace-scoped. A2A is OFF by default and owner-workspace-first (the call route 409s
 * until the workspace opts in), so a deployment that sets nothing exposes the catalog and enables no call.
 */
export async function agentRegistryRoutes(
  app: FastifyInstance,
  opts: AgentRegistryRoutesOptions,
): Promise<void> {
  const service = createAgentRegistryService(opts.sessionManager);

  // The contract catalog + per-workspace present/enabled flags. Read-only.
  app.get("/workspaces/:wid/agent-registry", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const result = await service.listAgents({ workspaceId: wid, memberId: id.memberId });
    return {
      enabled: result.enabled,
      agents: result.entries.map((e) => ({ ...e.contract, present: e.present, enabled: e.enabled })),
    };
  });

  // Run a governed A2A call: from one fleet agent to another, for a declared capability. Human-auth.
  app.post("/workspaces/:wid/agent-registry/call", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (id.kind !== "human") return reply.code(401).send({ error: "human authentication required" });
    if (!assertWorkspace(id, wid, reply)) return;
    const b = (req.body ?? {}) as {
      from?: string;
      to?: string;
      capability?: string;
      task?: string;
      callChain?: string[];
    };
    if (
      typeof b.from !== "string" ||
      typeof b.to !== "string" ||
      typeof b.capability !== "string" ||
      typeof b.task !== "string"
    ) {
      return reply.code(400).send({ error: "from, to, capability and task are required" });
    }
    const result = await service.call(
      { workspaceId: wid, memberId: id.memberId },
      {
        callerHandle: b.from,
        targetHandle: b.to,
        capability: b.capability,
        task: b.task,
        callChain: Array.isArray(b.callChain) ? b.callChain : undefined,
      },
    );
    if (!result.ok) {
      return reply.code(result.code).send({ error: result.error, decision: result.decision?.record });
    }
    return reply.code(202).send({ call: result.decision.record, dispatch: result.dispatch });
  });
}
