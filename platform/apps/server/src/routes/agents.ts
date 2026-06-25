import type { FastifyInstance } from "fastify";
import { resolveIdentity } from "../auth/middleware.js";
import { generateAgentToken } from "../auth/secrets.js";
import {
  createAgentWithToken,
  revokeAgentToken,
  listAgents,
  deactivateAgent,
} from "../db/repositories/auth.js";
import { checkPlanQuota, type PlanQuotaReaders } from "../billing/entitlements.js";
import { defaultPlanQuotaReaders } from "../billing/entitlements-default.js";

export interface AgentRoutesOptions {
  planQuota?: PlanQuotaReaders;
}

export async function agentRoutes(app: FastifyInstance, opts: AgentRoutesOptions = {}): Promise<void> {
  const planQuota = opts.planQuota ?? defaultPlanQuotaReaders;
  // List the workspace's agent registry (profiles). Any workspace member may read the roster.
  app.get("/workspaces/:workspaceId/agents", async (req, reply) => {
    const identity = await resolveIdentity(req);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const { workspaceId } = req.params as { workspaceId: string };
    if (identity.workspaceId !== workspaceId) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    return listAgents(workspaceId);
  });

  // Deactivate an agent: block auth + revoke its tokens (immediate). Owner/human-only.
  app.post("/workspaces/:workspaceId/agents/:agentId/deactivate", async (req, reply) => {
    const identity = await resolveIdentity(req);
    if (!identity || identity.kind !== "human") {
      return reply.code(401).send({ error: "human authentication required" });
    }
    const { workspaceId, agentId } = req.params as { workspaceId: string; agentId: string };
    if (identity.workspaceId !== workspaceId) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    const ok = await deactivateAgent(agentId, workspaceId);
    if (!ok) return reply.code(404).send({ error: "agent not found in this workspace" });
    return { ok: true };
  });

  // Register an agent in a workspace and mint its first token (returned ONCE).
  app.post("/workspaces/:workspaceId/agents", async (req, reply) => {
    const identity = await resolveIdentity(req);
    if (!identity || identity.kind !== "human") {
      return reply.code(401).send({ error: "human authentication required" });
    }
    const { workspaceId } = req.params as { workspaceId: string };
    if (identity.workspaceId !== workspaceId) {
      return reply.code(403).send({ error: "not a member of this workspace" });
    }
    const b = req.body as { name?: string; framework?: string };
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const quota = await checkPlanQuota(planQuota, workspaceId, "agent");
    if (!quota.ok) {
      return reply.code(quota.statusCode).send({
        error: quota.error,
        resource: quota.resource,
        limit: quota.limit,
        used: quota.used,
        planKey: quota.plan.planKey,
      });
    }

    const { raw, hash } = generateAgentToken();
    const created = await createAgentWithToken({
      workspaceId,
      name: b.name,
      framework: b.framework,
      tokenHash: hash,
    });
    // `token` is shown exactly once; only its hash is stored.
    return reply.code(201).send({ ...created, token: raw });
  });

  app.post(
    "/workspaces/:workspaceId/agents/:agentId/tokens/:tokenId/revoke",
    async (req, reply) => {
      const identity = await resolveIdentity(req);
      if (!identity || identity.kind !== "human") {
        return reply.code(401).send({ error: "human authentication required" });
      }
      const { workspaceId, tokenId } = req.params as { workspaceId: string; tokenId: string };
      if (identity.workspaceId !== workspaceId) {
        return reply.code(403).send({ error: "not a member of this workspace" });
      }
      const revoked = await revokeAgentToken(tokenId, workspaceId);
      if (!revoked) return reply.code(404).send({ error: "token not found in this workspace" });
      return { ok: true };
    },
  );
}
