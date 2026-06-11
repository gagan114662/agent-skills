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
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { listMentionsOnMessage } from "../db/repositories/mentions.js";
import { getPersona, getPersonaByHandle, definePersona } from "../db/repositories/personas.js";
import { createMarketingTask } from "../db/repositories/marketing-tasks.js";
import { personaMentionsOnMessage } from "../messaging/subagent-mentions.js";
import { SubagentService, type SubagentLauncher } from "../subagents/service.js";
import { createVentureAdmission } from "../venture/default.js";
import { loadConfig } from "../config/loader.js";
import { loadEnv } from "../env.js";
import { harnessRequiresAuth } from "../runtime/agent-auth.js";
import { createAgentAuthResolver } from "../runtime/auth-default.js";
import { buildConnectPrompt } from "./connect-prompt.js";
import type { MarketingMentionTrigger } from "../messaging/delivery.js";
import { MARKETING_CHANNELS, departmentForHandle, skillsForHandle } from "./blueprint.js";
import { resolveMarketingCaps } from "./caps.js";
import { seedMarketingDepartment, type MarketingSeedDeps, type MarketingSeedResult } from "./seed.js";
import { runMarketingBackfill, type MarketingBackfillResult } from "./backfill.js";
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

/**
 * The real-repo seams the seeder needs that DON'T require a SessionManager (channels, grants, personas,
 * posting). The boot backfill (#138) uses exactly these — it never launches welcome sessions, so it can
 * run from `index.ts` without reaching into `buildApp`'s SessionManager.
 */
function baseSeedDeps(): Omit<MarketingSeedDeps, "launchWelcome" | "recordTask"> {
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
  };
}

/** The full seam set for the seeder, adding welcome launches through the gated launcher. */
function seedDeps(sessionManager: SessionManager): MarketingSeedDeps {
  const launcher = ventureGatedSubagentLauncher(sessionManager);
  return {
    ...baseSeedDeps(),
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

/**
 * Idempotently backfill the department fleet for every existing enabled workspace on boot (#138). Signup
 * auto-seed only covers new workspaces; this is how the owner's pre-existing workspace (and any other
 * tenant created before the fleet was turned on) gets its agency. Never launches welcome sessions (uses
 * the launcher-free `baseSeedDeps`, `postWelcomeTasks: false`) so it cannot spend; best-effort per
 * workspace via `runMarketingBackfill`. Returns counts for the boot log.
 */
export async function backfillMarketingDepartments(log: FastifyBaseLogger): Promise<MarketingBackfillResult> {
  const deps = baseSeedDeps();
  return runMarketingBackfill({
    listWorkspaceIds,
    ownerMemberId: async (workspaceId) =>
      (await listWorkspaceMembers(workspaceId)).find((m) => m.kind === "human")?.id,
    isEnabled: (workspaceId) => resolveMarketingCaps(loadConfig(workspaceId).marketing).enabled,
    seed: ({ workspaceId, createdByMemberId }) =>
      seedMarketingDepartment({ workspaceId, createdByMemberId, postWelcomeTasks: false }, deps).then(() => undefined),
    log,
  });
}

/** Build the @mention → real session trigger over the audited #59 gate + venture-gated launcher. */
export function createMarketingMentionService(sessionManager: SessionManager): MarketingMentionService {
  const authResolver = createAgentAuthResolver();
  const subagents = new SubagentService({
    getPersona,
    getChannelWorkspace: async (channelId) => (await getChannel(channelId))?.workspaceId,
    channelCapabilityFor: effectiveChannelCapabilityFor,
    mentionedMemberIds: async (messageId) => (await listMentionsOnMessage(messageId)).map((m) => m.memberId),
    resolveSkills: (persona) => skillsForHandle(persona.name), // #155: load the agent's skill kit per session
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
    // #68 subscription-first auth gate: when the deployment runs a REAL harness (claude-code/codex) and
    // a workspace hasn't connected a Claude account, the persona posts a friendly connect prompt
    // instead of launching — no session, no admission slot, no budget. For the default demo harness
    // `required` is false, so this is inert and behavior is unchanged. The auth resolver is the SAME
    // one the SessionManager injects secrets from, so the gate and the runtime can never disagree.
    auth: {
      required: harnessRequiresAuth(loadEnv().agent.harness),
      hasAuth: async (workspaceId) => (await authResolver.resolve(workspaceId)).mode !== "none",
      postConnectPrompt: async (input) =>
        channelPoster.post({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentMemberId: input.agentMemberId,
          body: buildConnectPrompt(input.personaName),
          parentMessageId: input.parentMessageId,
        }),
    },
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

/**
 * The #123 post-time @mention trigger (the prod-incident fix): build the marketing mention service once
 * and return a {@link MarketingMentionTrigger} the shared message fan-out (`messaging/delivery.ts`) runs
 * for every freshly-posted message. Gating (cheap, before any DB work):
 *   - **human authors only** — agent posts must not auto-trigger launches (no @mention loops); MCP
 *     agent posts share the same fan-out, so this guard matters there too.
 *   - **marketing channels only** — `channel.name` is already on the message; non-marketing channels
 *     return immediately with zero extra queries.
 * For a qualifying post, `mention.launch` runs the SAME audited path as the explicit `/marketing` route
 * (#68 auth gate → #59 SubagentService → #96 venture gate → #71 admission → session). No mentioned
 * persona → `{ok:false}`, a harmless no-op. The fan-out invokes this best-effort and swallows denials.
 */
export function buildMarketingMentionTrigger(sessionManager: SessionManager): MarketingMentionTrigger {
  const mention = createMarketingMentionService(sessionManager);
  return async (identity, channel, message) => {
    if (identity.kind !== "human") return;
    if (channel.name === null || !MARKETING_CHANNELS.includes(channel.name)) return;
    await mention.launch(
      { workspaceId: identity.workspaceId, memberId: identity.memberId },
      { channelId: channel.id, messageId: message.id, task: message.body },
    );
  };
}
