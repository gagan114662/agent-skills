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
import { createMarketingTask, listMarketingTasks } from "../db/repositories/marketing-tasks.js";
import { createIdea, getOrCreateEvaluation, listEvaluations } from "../db/repositories/venture.js";
import { foundingVentureFor } from "./blueprint.js";
import { personaMentionsOnMessage } from "../messaging/subagent-mentions.js";
import { SubagentService, type SubagentLauncher } from "../subagents/service.js";
import { spawnToolsForWorkspace } from "../subagents/collaboration.js";
import { createVentureAdmission, kickoffFoundingVenture } from "../venture/default.js";
import { loadConfig } from "../config/loader.js";
import { loadEnv } from "../env.js";
import { harnessRequiresAuth } from "../runtime/agent-auth.js";
import { createAgentAuthResolver } from "../runtime/auth-default.js";
import { getWorkspaceClaudeModel, recordClaudeAuthFailure } from "../db/repositories/agent-credentials.js";
import { effectiveModel, isKnownModel } from "../runtime/models.js";
import { buildConnectPrompt, buildModelPrompt } from "./connect-prompt.js";
import type { MarketingMentionTrigger } from "../messaging/delivery.js";
import { MARKETING_CHANNELS, departmentForHandle, skillsForHandle } from "./blueprint.js";
import { resolveMarketingCaps } from "./caps.js";
import { seedMarketingDepartment, type MarketingSeedDeps, type MarketingSeedResult } from "./seed.js";
import { runMarketingBackfill, type MarketingBackfillResult } from "./backfill.js";
import { MarketingMentionService } from "./mention.js";
import { MarketingBriefService } from "./brief.js";
import { resolveDedupeEnabled } from "./dedup.js";
import {
  resolveWorkspaceFacts,
  enrichTaskWithContext,
  shouldInjectWorkspaceContext,
  BRAND_VOICE_LINE,
} from "./workspace-context.js";
import { getWorkspaceOnboarding } from "../db/repositories/workspace-onboarding.js";
import { postMessage } from "../db/repositories/messages.js";
import { resolveAndPersistMentions } from "../db/repositories/mentions.js";

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

/**
 * #221: stand up the workspace's first venture so the activated console has a live pipeline. Idempotent —
 * if the workspace already has any evaluation we return it untouched (re-seed never multiplies the
 * pipeline). A fresh workspace gets the founding idea + its durable #96 evaluation (status `active`), which
 * is exactly what `venturePipeline.total` counts on the Founder Console. A DB row, never a launch, so it
 * consumes no #71 admission slot and cannot 429. Shared by the seeder and the #226 boot venture-backfill.
 */
async function ensureFoundingVenture(
  workspaceId: string,
  createdByMemberId: string,
): Promise<{ ideaId: string; created: boolean }> {
  const existing = await listEvaluations(workspaceId);
  if (existing.length > 0) return { ideaId: existing[0]!.ideaId, created: false };
  // #235: in the owner's own workspace ipop runs ITS OWN marketing as venture #1 — the concrete
  // "acquire paying founders for ipop.ai" dogfood brief, whose wedge folds into every lead's welcome
  // session + the funded epic. Any other workspace keeps the brand-neutral founding stub (a customer
  // never inherits ipop's growth brief). The owner workspace is the `marketing.ownerWorkspaceId` marker
  // (default unset → the generic stub for everyone).
  const caps = resolveMarketingCaps(loadConfig(workspaceId).marketing);
  const seed = foundingVentureFor(workspaceId, caps.ownerWorkspaceId);
  const idea = await createIdea({ ...seed, workspaceId, createdByMemberId });
  await getOrCreateEvaluation(workspaceId, idea.id);
  return { ideaId: idea.id, created: true };
}

/** The full seam set for the seeder, adding welcome launches through the gated launcher. */
function seedDeps(sessionManager: SessionManager): MarketingSeedDeps {
  const launcher = ventureGatedSubagentLauncher(sessionManager);
  return {
    ...baseSeedDeps(),
    launchWelcome: async (input) => launcher.launch(input),
    recordTask: async (input) => createMarketingTask(input),
    ensureFirstVenture: ({ workspaceId, createdByMemberId }) =>
      ensureFoundingVenture(workspaceId, createdByMemberId),
    // #230: drive the venture through the #96 loop on activation so it produces a funded venture with an
    // epic + first tasks the leads pick up (idempotent — safe on a re-seed).
    activateVenture: ({ workspaceId, ideaId, createdByMemberId }) =>
      kickoffFoundingVenture(workspaceId, ideaId, createdByMemberId),
    // #221: fallback activation idempotency key (the venture row above is the authoritative one, #226/#227).
    countWelcomeTasks: async (workspaceId) =>
      (await listMarketingTasks(workspaceId)).filter((t) => t.kind === "welcome").length,
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
    // #226: an account activated before #221 has welcome tasks but no venture row — its console used to sit
    // on the empty desk forever. Conservatively stand up the missing venture ONLY for such already-activated
    // workspaces (those with ≥1 welcome task), so a merely auto-seeded tenant that never activated keeps its
    // genuine first-run empty desk.
    backfillVenture: async ({ workspaceId, createdByMemberId }) => {
      const welcomeTasks = (await listMarketingTasks(workspaceId)).filter((t) => t.kind === "welcome");
      if (welcomeTasks.length === 0) return { created: false };
      const { ideaId, created } = await ensureFoundingVenture(workspaceId, createdByMemberId);
      // #230: an account activated before this fix has a venture row that was never driven through the
      // #96 loop (epicTaskId null, iterations 0 — the exact live symptom). Drive it on boot so it gets a
      // funded venture with an epic + first tasks. Idempotent (a venture that already has an epic no-ops)
      // and best-effort (a kickoff failure must not abort the backfill of other workspaces).
      try {
        await kickoffFoundingVenture(workspaceId, ideaId, createdByMemberId);
      } catch {
        // The next activation / boot retries; the console diagnostic surfaces the inert venture meanwhile.
      }
      return { created };
    },
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
    extraToolsForWorkspace: spawnToolsForWorkspace, // #319: gated subagent-spawn tool (default OFF, owner-first)
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
    // #320: enrich the launched task with the workspace-context preamble so a briefed agent has the real
    // site URL + product context + brand voice on file instead of returning a placeholder. Default OFF and
    // owner-workspace-first (`shouldInjectWorkspaceContext`): a deployment that hasn't opted in returns the
    // task unchanged, so every existing launch is byte-for-byte the same. Facts are read from the existing
    // `workspace_onboarding` row + `marketing.*` config — no new authority, no send/spend reachable.
    enrichTask: async (workspaceId, task) => {
      const marketing = loadConfig(workspaceId).marketing;
      if (!shouldInjectWorkspaceContext(marketing, workspaceId)) return task;
      const onboarding = await getWorkspaceOnboarding(workspaceId);
      const facts = resolveWorkspaceFacts({
        workspaceId,
        ownerWorkspaceId: marketing.ownerWorkspaceId,
        configuredSiteUrl: marketing.siteUrl,
        domain: onboarding?.domain ?? null,
        productContext: onboarding?.productContext ?? null,
        brandVoice: BRAND_VOICE_LINE,
      });
      return enrichTaskWithContext(task, facts);
    },
    // #68 subscription-first auth gate: when the deployment runs a REAL harness (claude-code/codex) and
    // a workspace hasn't connected a Claude account, the persona posts a friendly connect prompt
    // instead of launching — no session, no admission slot, no budget. For the default demo harness
    // `required` is false, so this is inert and behavior is unchanged. The auth resolver is the SAME
    // one the SessionManager injects secrets from, so the gate and the runtime can never disagree.
    auth: {
      required: harnessRequiresAuth(loadEnv().agent.harness),
      hasAuth: async (workspaceId) => (await authResolver.resolve(workspaceId)).mode !== "none",
      // #365: when a launch is denied for missing auth, stamp the connection-health signal. Row-scoped, so
      // it is a no-op for a never-connected workspace and only flips a CONNECTED workspace whose stored
      // token no longer resolves to `expired` (→ "reconnect"). Never changes the gate's decision.
      onAuthUnavailable: async (workspaceId) => recordClaudeAuthFailure(workspaceId),
      postConnectPrompt: async (input) =>
        channelPoster.post({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentMemberId: input.agentMemberId,
          body: buildConnectPrompt(input.personaName),
          parentMessageId: input.parentMessageId,
        }),
    },
    // #246 model preflight: same shape as the auth gate. Resolves the workspace's effective fleet model
    // (owner pick → deployment default → canonical) and validates it against the models known to resolve;
    // an unservable id posts an actionable "pick a valid model" prompt instead of launching a session
    // that would 403 + crash mid-run. Same SAME default model logic the SessionManager launch gate uses.
    model: {
      required: harnessRequiresAuth(loadEnv().agent.harness),
      check: async (workspaceId) => {
        const model = effectiveModel({
          workspacePicked: await getWorkspaceClaudeModel(workspaceId),
          envDefault: process.env.ANTHROPIC_MODEL ?? null,
        });
        return isKnownModel(model) ? { ok: true } : { ok: false, model };
      },
      postModelPrompt: async (input) =>
        channelPoster.post({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          agentMemberId: input.agentMemberId,
          body: buildModelPrompt(input.personaName, input.model),
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
    // #322 idempotent task creation: a re-briefed objective that already has an OPEN (`launched`) task in
    // the same department is skipped — no duplicate session / draft. DEFAULT-OFF, owner-workspace-first
    // (`resolveDedupeEnabled`), so the default posture and every existing test launch exactly as before.
    dedupe: {
      isEnabled: async (workspaceId) =>
        resolveDedupeEnabled(loadConfig(workspaceId).marketing, workspaceId),
      openTasks: async (workspaceId) =>
        (await listMarketingTasks(workspaceId))
          .filter((t) => t.status === "launched")
          .map((t) => ({ id: t.id, department: t.department, task: t.task })),
    },
    departmentForHandle: (handle) => departmentForHandle(handle)?.key,
  });
}

/**
 * The owner BRIEF → real session service (#235): post the owner's brief into a department lead's channel
 * and launch the lead through the SAME audited @mention path as {@link createMarketingMentionService}. We
 * post via the repo directly (so the post-time fan-out trigger does NOT also fire — no double launch) and
 * persist the @mention ourselves, then delegate the launch. No new launch authority.
 */
export function createMarketingBriefService(sessionManager: SessionManager): MarketingBriefService {
  const mention = createMarketingMentionService(sessionManager);
  return new MarketingBriefService({
    resolveLead: (handle) => {
      const d = departmentForHandle(handle);
      return d ? { handle: d.agent.handle, department: d.key, channel: d.channel } : undefined;
    },
    getChannelByName: async (workspaceId, name) => {
      const ch = (await listChannels(workspaceId)).find((c) => c.name === name);
      return ch ? { id: ch.id } : undefined;
    },
    post: async (input) =>
      postMessage({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        authorMemberId: input.authorMemberId,
        body: input.body,
      }),
    recordMentions: async (input) => {
      await resolveAndPersistMentions(input);
    },
    launch: (identity, input) =>
      mention.launch(identity, {
        channelId: input.channelId,
        messageId: input.messageId,
        task: input.task,
      }),
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
