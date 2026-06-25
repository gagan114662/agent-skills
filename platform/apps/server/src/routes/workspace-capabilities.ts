import type { FastifyInstance } from "fastify";
import { assertWorkspace, requireIdentity } from "../auth/guard.js";
import { dbWorkspacePlanStore } from "../db/repositories/plans.js";
import { WORKSPACE_RUNTIME_CAPABILITIES } from "../db/schema/index.js";
import {
  listWorkspaceCapabilities,
  setWorkspaceCapability,
  type WorkspaceRuntimeCapability,
} from "../db/repositories/workspace-capabilities.js";
import { loadWorkspaceConfig } from "../config/workspace-capabilities.js";
import { resolveMarketingCaps } from "../marketing/caps.js";
import { resolveOnboardingCaps } from "../onboarding/caps.js";
import { resolveRealworldCaps } from "../realworld/caps.js";

function bodyBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function activePaidPlan(plan: Awaited<ReturnType<typeof dbWorkspacePlanStore.getActive>>): boolean {
  return !!plan && plan.status === "active" && plan.renewalStatus === "active";
}

export async function workspaceCapabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:wid/capabilities", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const [config, overrides, plan] = await Promise.all([
      loadWorkspaceConfig(wid),
      listWorkspaceCapabilities(wid),
      dbWorkspacePlanStore.getActive(wid),
    ]);
    return {
      planRequired: true,
      paidPlanActive: activePaidPlan(plan),
      overrides,
      capabilities: {
        marketing: resolveMarketingCaps(config.marketing).enabled,
        onboarding: resolveOnboardingCaps(config.onboarding).enabled,
        realworld: resolveRealworldCaps(config.realworld).enabled,
      },
    };
  });

  app.patch("/workspaces/:wid/capabilities", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const plan = await dbWorkspacePlanStore.getActive(wid);
    if (!activePaidPlan(plan)) {
      return reply.code(402).send({ error: "active paid plan required" });
    }
    const body = (req.body ?? {}) as Partial<Record<WorkspaceRuntimeCapability, unknown>>;
    const updates: Array<{ capability: WorkspaceRuntimeCapability; enabled: boolean }> = [];
    for (const capability of WORKSPACE_RUNTIME_CAPABILITIES) {
      if (body[capability] === undefined) continue;
      const enabled = bodyBool(body[capability]);
      if (enabled === null) return reply.code(400).send({ error: `${capability} must be boolean` });
      updates.push({ capability, enabled });
    }
    if (updates.length === 0) return reply.code(400).send({ error: "no capability updates supplied" });
    const saved = await Promise.all(
      updates.map((update) =>
        setWorkspaceCapability({
          workspaceId: wid,
          capability: update.capability,
          enabled: update.enabled,
          updatedByMemberId: id.memberId,
        }),
      ),
    );
    const config = await loadWorkspaceConfig(wid);
    return {
      updated: saved,
      capabilities: {
        marketing: resolveMarketingCaps(config.marketing).enabled,
        onboarding: resolveOnboardingCaps(config.onboarding).enabled,
        realworld: resolveRealworldCaps(config.realworld).enabled,
      },
    };
  });
}
