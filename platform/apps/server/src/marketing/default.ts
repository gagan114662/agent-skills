import type { FastifyBaseLogger } from "fastify";
import type { SessionManager } from "../runtime/manager.js";
import { channelPoster } from "../runtime/default.js";
import { generateAgentToken } from "../auth/secrets.js";
import { effectiveChannelCapabilityFor } from "../auth/access.js";
import {
  listChannels,
  createChannel,
  addChannelMember,
  getChannel,
} from "../db/repositories/channels.js";
import { grantCapability } from "../db/repositories/permissions.js";
import { listMentionsOnMessage } from "../db/repositories/mentions.js";
import { getPersona, getPersonaByHandle, definePersona } from "../db/repositories/personas.js";
import { createMarketingTask } from "../db/repositories/marketing-tasks.js";
import { personaMentionsOnMessage } from "../messaging/subagent-mentions.js";
import { SubagentService, type SubagentLauncher } from "../subagents/service.js";
import { createVentureAdmission } from "../venture/default.js";
import { loadConfig } from "../config/loader.js";
import { MARKETING_CHANNELS, departmentForHandle } from "./blueprint.js";
import { resolveMarketingCaps } from "./caps.js";
import { seedMarketingDepartment, type MarketingSeedDeps, type MarketingSeedResult } from "./seed.js";
import { MarketingMentionService } from "./mention.js";

/**
 * Production wiring for the Marketing Department Fleet (#123, ADR-0123). Binds the pure orchestrators
 * (`seedMarketingDepartment`, `MarketingMentionService`) to the real #4/#9/#59/#25 repos. Every launch —
 * a welcome session or an @mention — goes through the **venture-gated launcher**: `gate.check()` (the
 * #96 anti-demo gate, default-OFF → transparent) then `sessionManager.launch()` (the #71 admission
 * chokepoint: kill switch, tenant budget, concurrency). No new authority — the @mention path reuses the
 * audited #59 `SubagentService` gate verbatim.
 */

/** A SubagentLauncher that clears the #96 venture gate before launching through the #25 manager. */
function ventureGatedSubagentLauncher(sessionManager: SessionManager): SubagentLauncher {
  const gate = createVentureAdmission();
  return {
    launch: async (input) => {
      await gate.check(input.workspaceId);
      return sessionManager.launch(input);
    },
  };
}

/** The real-repo seam set for the seeder, with welcome launches through the gated launcher. */
function seedDeps(sessionManager: SessionManager): MarketingSeedDeps {
  const launcher = ventureGatedSubagentLauncher(sessionManager);
  return {
    getChannelByName: async (workspaceId, name) => {
      const ch = (await listChannels(workspaceId)).find((c) => c.name === name);
      return ch ? { id: ch.id } : undefined;
    },
    createChannel: async ({ workspaceId, name }) => {
      const ch = await createChannel({ workspaceId, kind: "public", name });
      return { id: ch.id, name: ch.name ?? name };
    },
    addChannelMember,
    grantPropagate: async ({ workspaceId, memberId, channelId, grantedByMemberId }) =>
      grantCapability({
        workspaceId,
        memberId,
        resourceType: "channel",
        resourceId: channelId,
        capability: "propagate",
        grantedByMemberId,
      }),
    getPersonaByHandle: async (workspaceId, handle) => {
      const p = await getPersonaByHandle(workspaceId, handle);
      return p ? { id: p.id, agentMemberId: p.agentMemberId } : undefined;
    },
    createPersona: async (spec) => {
      const { hash } = generateAgentToken();
      const p = await definePersona(
        {
          workspaceId: spec.workspaceId,
          name: spec.name,
          systemPrompt: spec.systemPrompt,
          allowedTools: spec.allowedTools,
          model: spec.model,
          isBuiltin: true,
          tokenHash: hash,
        },
        spec.createdByMemberId,
      );
      return { id: p.id, agentMemberId: p.agentMemberId };
    },
    post: async (input) => channelPoster.post(input),
    launchWelcome: async (input) => launcher.launch(input),
    recordTask: async (input) => createMarketingTask(input),
  };
}

/** Seed the department fleet for a workspace (explicit route + signup auto-seed share this). */
export async function seedDepartmentForWorkspace(
  sessionManager: SessionManager,
  input: { workspaceId: string; createdByMemberId: string; welcomeTasks?: boolean },
): Promise<MarketingSeedResult> {
  return seedMarketingDepartment(
    {
      workspaceId: input.workspaceId,
      createdByMemberId: input.createdByMemberId,
      postWelcomeTasks: input.welcomeTasks ?? false,
    },
    seedDeps(sessionManager),
  );
}

/**
 * Seed the fleet on signup when the workspace's `marketing` policy opts in (#58, default OFF). Best
 * effort: a seed failure is logged and never fails the signup that already succeeded.
 */
export async function maybeAutoSeedOnSignup(
  sessionManager: SessionManager,
  workspaceId: string,
  memberId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const caps = resolveMarketingCaps(loadConfig(workspaceId).marketing);
    if (!caps.enabled) return;
    await seedMarketingDepartment(
      { workspaceId, createdByMemberId: memberId, postWelcomeTasks: caps.seedWelcomeTasks },
      seedDeps(sessionManager),
    );
  } catch (err) {
    log.error({ err }, "marketing department auto-seed failed");
  }
}

/** Build the @mention → real session trigger over the audited #59 gate + venture-gated launcher. */
export function createMarketingMentionService(sessionManager: SessionManager): MarketingMentionService {
  const subagents = new SubagentService({
    getPersona,
    getChannelWorkspace: async (channelId) => (await getChannel(channelId))?.workspaceId,
    channelCapabilityFor: effectiveChannelCapabilityFor,
    mentionedMemberIds: async (messageId) => (await listMentionsOnMessage(messageId)).map((m) => m.memberId),
    launcher: ventureGatedSubagentLauncher(sessionManager),
  });

  return new MarketingMentionService({
    getChannel: async (channelId) => {
      const c = await getChannel(channelId);
      return c ? { id: c.id, workspaceId: c.workspaceId, name: c.name } : undefined;
    },
    isMarketingChannel: (name) => name !== null && MARKETING_CHANNELS.includes(name),
    personaMentions: async (workspaceId, messageId) =>
      (await personaMentionsOnMessage(workspaceId, messageId)).map((p) => ({
        id: p.id,
        agentMemberId: p.agentMemberId,
        name: p.name,
      })),
    invoke: (identity, input) => subagents.invoke(identity, input),
    recordTask: async (input) =>
      createMarketingTask({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        department: input.department,
        agentMemberId: input.agentMemberId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        kind: "mention",
        task: input.task,
        createdByMemberId: input.createdByMemberId,
      }),
    departmentForHandle: (handle) => departmentForHandle(handle)?.key,
  });
}
