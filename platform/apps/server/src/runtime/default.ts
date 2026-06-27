import { isAbsolute, join } from "node:path";
import { loadEnv } from "../env.js";
import { loadConfig } from "../config/loader.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import { createGitWorkspaceFromEnv } from "../git/default.js";
import { GitWorkspaceProvisioner } from "../git/provisioner.js";
import { maybePooledWorktreeProvisioner } from "../worktree-pool/provisioner.js";
import {
  createAgentSession,
  finalizeSession,
  forceFinalizeIfLive,
  heartbeatSession,
  markSessionRunning,
} from "../db/repositories/agent-sessions.js";
import { postMessage } from "../db/repositories/messages.js";
import { createRequest, listPolicyRules } from "../db/repositories/approvals.js";
import { evaluatePolicy } from "../approvals/policy.js";
import { buildDeliveryDispatcher } from "../delivery/default.js";
import { createDefaultVerificationEngine } from "../verification/default.js";
import { publishMessageEvent } from "../realtime/bus.js";
import { createRuntime } from "./factory.js";
import {
  googleConnectionOAuthRequiredForRelease,
  googleOAuthRequiredForRelease,
  preflight,
  type PreflightReport,
} from "./preflight.js";
import {
  EnvSecretsResolver,
  ExternalSecretsResolver,
  ScopedSecretsResolver,
  SubscriptionSecretsResolver,
} from "./secrets-resolver.js";
import { resolveCredentialMatrix } from "./credential-scope.js";
import { getPersonaByAgentMember } from "../db/repositories/personas.js";
import { getWorkspaceBySlug } from "../db/repositories/workspaces.js";
import { getWorkspaceClaudeModel } from "../db/repositories/agent-credentials.js";
import { resolveOnboardingCaps } from "../onboarding/caps.js";
import { resolveAllServiceSecrets } from "../db/repositories/external-credentials.js";
import { createAgentAuthResolver } from "./auth-default.js";
import {
  SessionManager,
  type ChannelPoster,
  type SessionLogger,
  type SessionStore,
} from "./manager.js";
import { formatDeliverableMessage } from "./outcome.js";
import {
  isAgentChannelPostingEnabledForWorkspace,
  resolveAgentChannelPostingCaps,
} from "../agent-channel-bridge/caps.js";
import { resolveSelfqaCaps } from "../selfqa/caps.js";
import { AutoModelResolver } from "./auto-model.js";
import { HttpGatewayRoutingClient } from "./gateway-client.js";
import { usageStore } from "../db/repositories/tenant-usage.js";
import { setKillSwitch } from "../db/repositories/autonomy.js";
import { harnessLineDecoder } from "./stream-json.js";
import { harnessSpec, type HarnessKind } from "./harness.js";
import { createBraintrustTracer } from "../observability/braintrust.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { resolveBrowserCaps } from "./browser/caps.js";
import { createScale, type Scale } from "../scale/default.js";
import { createSpendAnomalyMonitor } from "../scale/spend-anomaly.js";
import { createDefaultEnterpriseService } from "../enterprise/default.js";
import { selfHealingStore } from "../db/repositories/self-healing.js";
import {
  recordSpawnFailureIncident,
  resolveSpawnFailureIncident,
} from "../self-healing/spawn-incident.js";
import {
  recordModelFailureIncident,
  resolveModelFailureIncident,
} from "../self-healing/model-incident.js";

/** Repository-backed session store (exported so integration tests reuse real persistence). */
export const dbStore: SessionStore = {
  create: createAgentSession,
  markRunning: markSessionRunning,
  heartbeat: heartbeatSession,
  finalize: finalizeSession,
  // #248: race-safe terminal write used to cancel an orphaned/cross-process session and to defend the
  // pre-start vanish path — only finalizes a still-live row (never stomps a concurrent finalize).
  forceFinalize: forceFinalizeIfLive,
};

/**
 * A post-time hook fired for every AGENT channel post (#170). Registered once at boot by the Slack
 * bridge so an agent's reply can be mirrored back into the Slack thread the human started — keyed on
 * the reply's `parentMessageId`. Module-level + best-effort, mirroring the #123
 * `setMarketingMentionTrigger` seam. Only agent posts run through `channelPoster`, so this never sees a
 * human's message — which is what keeps the Slack mirror from echoing.
 */
export interface ChannelPostHookInput {
  workspaceId: string;
  channelId: string;
  messageId: string;
  parentMessageId?: string;
  body: string;
}
export type ChannelPostHook = (post: ChannelPostHookInput) => Promise<void>;

let channelPostHook: ChannelPostHook | undefined;

/** Register (or clear, with `undefined`) the agent-post hook. Called from `buildApp`. */
export function setChannelPostHook(fn: ChannelPostHook | undefined): void {
  channelPostHook = fn;
}

/**
 * A hook fired AFTER an agent's deliverable is posted to its channel (#417). When an agent's deliverable
 * @mentions a fleet teammate, the wired hook launches that teammate through the EXISTING governed a2a path
 * (depth/cycle/capability-bounded) so the #416 "@mention the right teammate in-channel" prompt fires a
 * real, visible handoff. Module-level + best-effort, mirroring `setChannelPostHook`. Registered once at
 * boot in `buildApp`, AFTER the SessionManager and the AgentRegistryService both exist (breaking the
 * manager↔service cycle). Gated by the existing `agentCollaboration` capability inside the hook — with it
 * off the hook is a no-op and behavior is byte-for-byte unchanged.
 */
export interface DeliverableHandoffHookInput {
  workspaceId: string;
  agentMemberId: string;
  task: string;
  deliverable: string;
}
export type DeliverableHandoffHook = (input: DeliverableHandoffHookInput) => Promise<void>;

let deliverableHandoffHook: DeliverableHandoffHook | undefined;

/** Register (or clear, with `undefined`) the deliverable-handoff hook. Called from `buildApp`. */
export function setDeliverableHandoffHook(fn: DeliverableHandoffHook | undefined): void {
  deliverableHandoffHook = fn;
}

/**
 * Channel poster: persists the message (REST source of truth) and best-effort publishes it to
 * the #5 realtime fan-out so connected clients see streamed output live. A Redis hiccup never
 * fails the session — the message is already persisted.
 */
export const channelPoster: ChannelPoster = {
  async post(input) {
    const message = await postMessage({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      authorMemberId: input.agentMemberId,
      body: input.body,
      parentMessageId: input.parentMessageId,
    });
    publishMessageEvent(input.channelId, message).catch(() => {
      /* best-effort realtime; message is already persisted */
    });
    // #170: mirror the agent's reply back into Slack (best-effort; a hook failure never fails the post).
    if (channelPostHook) {
      void channelPostHook({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        messageId: message.id,
        parentMessageId: input.parentMessageId,
        body: input.body,
      }).catch(() => {
        /* best-effort Slack mirror; the message is already persisted */
      });
    }
    return { id: message.id };
  },
};

/**
 * Build the production SessionManager from env (#25). Default backend is `local`. The
 * `@vercel/sandbox` adapter is only constructed (and only loaded) when `AGENT_RUNTIME=sandbox`.
 */
/**
 * The production preflight thunk (#69): validate the live host posture against the configured
 * profile. Bound to `process.env` so it reflects the running deployment; the default `dev`/local/demo
 * posture always passes, so this gates only the opt-in cloud + real-agent path.
 */
export function defaultPreflight(): PreflightReport {
  const env = loadEnv().agent;
  // #174: gate the Playwright/Chromium checks on the deployment-wide browser flag (server-level config).
  const browserEnabled = resolveBrowserCaps(loadConfig().browser).enabled;
  // #238: resolve the per-session workspace root EXACTLY as the #58 FileConfigWorkspaceProvisioner does
  // (absolute as-is, else against the server cwd) so the writability probe targets the real provision
  // path — the EACCES that killed every prod session at provision is now a hard preflight failure.
  const wsRoot = loadConfig().workspaceRoot;
  const workspaceRoot = isAbsolute(wsRoot) ? wsRoot : join(process.cwd(), wsRoot);
  return preflight({
    profile: env.profile,
    runtime: env.runtime,
    harness: env.harness,
    env: process.env,
    browserEnabled,
    workspaceRoot,
    googleOAuthRequired: googleOAuthRequiredForRelease(env.profile, process.env),
    googleConnectionOAuthRequired: googleConnectionOAuthRequiredForRelease(env.profile, process.env),
    reach: loadConfig().reach,
    reachLiveProofRequired:
      env.profile === "prod" ||
      process.env.RELOAD_REACH_REQUIRE_LIVE_PROOF === "1" ||
      process.env.RELOAD_REACH_REQUIRE_LIVE_PROOF === "true",
  });
}

// #403 autonomous publishing: the delivery dispatcher used to SHIP a non-money deliverable the moment the
// agent finishes — no owner approval in the loop. Built lazily (the factory reads no per-request state) and
// shared across sessions. The dispatcher is self-gating: it returns null unless delivery is enabled for the
// workspace (owner-first), so this is a no-op everywhere delivery is off.
let _deliveryDispatcher: ReturnType<typeof buildDeliveryDispatcher> | undefined;
function deliveryDispatcher(logger: SessionLogger): ReturnType<typeof buildDeliveryDispatcher> {
  return (_deliveryDispatcher ??= buildDeliveryDispatcher(createDefaultVerificationEngine(logger)));
}

export async function isSyntheticSelfQaWorkspaceForAgentPosting(
  workspaceId: string,
  deps: {
    loadConfigForWorkspace?: typeof loadConfig;
    getWorkspaceBySlug?: typeof getWorkspaceBySlug;
  } = {},
): Promise<boolean> {
  const load = deps.loadConfigForWorkspace ?? loadConfig;
  const lookup = deps.getWorkspaceBySlug ?? getWorkspaceBySlug;
  const selfqa = resolveSelfqaCaps(load(workspaceId).selfqa);
  if (!selfqa.enabled) return false;
  const workspace = await lookup(selfqa.workspaceSlug);
  return workspace?.id === workspaceId;
}

export function createDefaultSessionManager(
  logger: SessionLogger,
  scale: Scale = createScale(0),
): SessionManager {
  const fullEnv = loadEnv();
  const env = fullEnv.agent;
  // Auto model-selection (convene-llm-gateway): wired only when a gateway URL is configured. The
  // resolver's own gates (the `RELOAD_AUTO_MODEL` master switch + per-tenant `autoModel.enabled` config)
  // keep it OFF by default — so with no gateway URL, or the flag off, every launch keeps today's
  // behavior. `usageStore` is the #71 usage READER, so the cost ceiling routed to the gateway is the
  // tenant's REMAINING window budget. The gateway KEY is read from `process.env.LLM_GATEWAY_KEY` inside
  // the HTTP client at call time — never baked here, never logged.
  const autoModel = fullEnv.autoModel.gatewayUrl
    ? new AutoModelResolver({
        client: new HttpGatewayRoutingClient({
          baseUrl: fullEnv.autoModel.gatewayUrl,
          timeoutMs: fullEnv.autoModel.timeoutMs,
        }),
        loadConfig: (workspaceId: string) => loadConfig(workspaceId),
        enabled: fullEnv.autoModel.enabled,
        gatewayConfigured: true,
        usage: usageStore,
      })
    : undefined;
  // #58: server-level config (managed-global) gates deployment-wide egress; per-tenant managed
  // overrides apply per session inside the workspace provisioner.
  const serverConfig = loadConfig();
  // #51: when a git repo is configured, each session runs in a git worktree on branch agent/<id> so
  // its edits become a reviewable diff/PR. Otherwise keep the #58 file-copy provisioner.
  const gitWorkspace = createGitWorkspaceFromEnv();
  const baseWorkspace: WorkspaceProvisioner = gitWorkspace
    ? new GitWorkspaceProvisioner(gitWorkspace)
    : new FileConfigWorkspaceProvisioner({ logger });
  // #343 opt-in treehouse worktree pool: when enabled (default OFF, owner-workspace-first) a session is
  // handed a warm reusable worktree (deps/build cache intact) instead of a fresh checkout. Additive —
  // with the flag off `maybePooledWorktreeProvisioner` returns `baseWorkspace` unchanged, and even when
  // wrapped the per-workspace gate falls back to a fresh checkout for every non-owner launch.
  const { provisioner: workspace } = maybePooledWorktreeProvisioner({
    fallback: baseWorkspace,
    gitWorkspace,
    loadConfig: (workspaceId?: string) => loadConfig(workspaceId),
    logger,
  });
  // #71: the warm pool is sized by the managed-global `[scale]` block. With size 0 (the default)
  // the factory returns a plain runtime (cold) — today's #25 behavior. Admission + usage are wired
  // unconditionally: with all caps 0 they admit everything (unchanged), but the #17 kill switch now
  // halts launches and per-tenant usage accrues so a configured budget can bite.
  const serverScale = resolveScaleCaps(serverConfig.scale);
  // #230: route a genuine session failure (spawn-and-die / harness crash / timeout) to the #117
  // self-healing flywheel so it fingerprints into a deduped issue instead of dying in silence — the
  // #166 gap where 21 sessions failed and nothing surfaced. Built lazily over THIS manager (the flywheel
  // needs it for fix-dispatch) and memoized; a dynamic import avoids a static import cycle. Record-only
  // here (the app's engine owns the dispatch tick); both share the module-singleton fingerprint store.
  let failureFlywheel: import("../flywheel/engine.js").FlywheelEngine | undefined;
  const manager: SessionManager = new SessionManager({
    runtime: createRuntime(env, undefined, {
      size: serverScale.warmPoolSize,
      regions: serverScale.regions,
    }),
    store: dbStore,
    poster: channelPoster,
    // #68 subscription-first: inject the workspace's OWN Claude subscription token
    // (`CLAUDE_CODE_OAUTH_TOKEN`) per tenant, falling back to the operator platform key only when the
    // workspace has none. Other secrets (e.g. `OPENAI_API_KEY` for codex) still flow via the inner
    // env resolver. The auth layer owns the credential keys so a platform key never ships alongside a
    // subscription token.
    // #151: per-agent scoping decorator wraps the #68 subscription resolver. With the credential matrix
    // OFF (the default) it passes the resolved secrets through byte-for-byte; when enabled it filters a
    // launching agent's secrets to its allowlisted purposes (scout↛Stripe). The matrix loads per-tenant
    // from the #58 config; the agentId→persona-name lookup is the personas repo.
    // #192: the external-account vault resolver wraps the inner env resolver and (only when a workspace
    // has opted into onboarding) merges in every connected external service's secrets — so the fleet
    // operates ESP/ad/analytics accounts without ever reading the key back (it flows only as injected,
    // redacted env). Default-OFF ⇒ byte-for-byte the prior chain. It sits INSIDE the #68 subscription
    // resolver so the model-auth keys stay authoritative, and INSIDE the #151 scoping decorator so a
    // scoped agent's external keys are still filtered to its allowlisted purposes.
    secrets: new ScopedSecretsResolver(
      new SubscriptionSecretsResolver(
        createAgentAuthResolver(),
        new ExternalSecretsResolver(new EnvSecretsResolver(), {
          isEnabled: (workspaceId) =>
            resolveOnboardingCaps(loadConfig(workspaceId).onboarding).enabled,
          loadServiceSecrets: (workspaceId) => resolveAllServiceSecrets(workspaceId),
        }),
      ),
      {
        loadMatrix: (workspaceId) =>
          resolveCredentialMatrix(loadConfig(workspaceId).credentialScopes),
        lookupAgentName: async (workspaceId, agentMemberId) =>
          (await getPersonaByAgentMember(workspaceId, agentMemberId))?.name ?? null,
      },
    ),
    harness: { command: env.harnessCommand, args: env.harnessArgs },
    // #50: the env default harness kind (persisted when a launch makes no per-session override).
    harnessKind: env.harness,
    // #81: decode the selected harness's stdout. `claude-code` emits stream-json (one JSON event per
    // line), `codex` emits codex `exec --json` events — without this the channel shows raw JSON
    // blobs; `demo` is a verbatim pass-through.
    decodeOutput: harnessLineDecoder(env.harness),
    // #50: per-session harness override resolver — maps an allowlisted kind to its trusted spec +
    // decoder so a launch can switch claude-code ↔ codex per session. Pure (no task), so it adds no
    // injection surface; both runtime backends honor the resolved spec identically. Binaries come
    // from env (CLAUDE_BIN / CODEX_BIN) just like the default spec.
    harnessOverrides: (kind: HarnessKind, opts?: { fast?: boolean }) => ({
      ...harnessSpec(kind, {
        claudeBin: process.env.CLAUDE_BIN,
        codexBin: process.env.CODEX_BIN,
        // #417 fast turn: a cheap model + no tools + no edit permission. Default-OFF — only set when a
        // launch opts into `fast`, so every existing launch builds the full spec byte-for-byte.
        fast: opts?.fast,
      }),
      decode: harnessLineDecoder(kind),
    }),
    caps: env.caps,
    // #436: bounded inline retry for a transient, pre-progress session death (spawn throw OR a process
    // that started then died with a null exit code and produced no output/heartbeat). Default 1 = OFF —
    // prod is byte-for-byte until flipped. `AGENT_SESSION_RETRY_MAX_ATTEMPTS=2` re-attempts the full
    // start→wait cycle once. `AGENT_SPAWN_RETRY_MAX_ATTEMPTS` is the deprecated alias (the original #435
    // narrow knob) — honored when the session var is unset so existing deployments keep working.
    sessionRetryMaxAttempts:
      Number(
        process.env.AGENT_SESSION_RETRY_MAX_ATTEMPTS ??
          process.env.AGENT_SPAWN_RETRY_MAX_ATTEMPTS ??
          1,
      ) || 1,
    logger,
    // #58 file-copy provisioner, or the #51 git-worktree provisioner when a repo is configured.
    workspace,
    // Braintrust agent-session tracing; a no-op unless BRAINTRUST_API_KEY is set, and forced off
    // under data-privacy mode (#58).
    tracer: createBraintrustTracer({ dataPrivacyMode: serverConfig.dataPrivacyMode }),
    // #71 cloud-scale admission (kill switch, budget, concurrency, placement) + usage accounting.
    // The SAME admission instance backs the usage route (shared in-memory counters), so the
    // dashboard's in-flight numbers reflect what the manager is actually running.
    admission: scale.admission,
    usage: scale.usage,
    enterprise: createDefaultEnterpriseService(),
    enterpriseComputeRateCentsPerMinute: (workspaceId) =>
      resolveScaleCaps(loadConfig(workspaceId).scale).computeRateCentsPerMinute,
    spendAnomaly: createSpendAnomalyMonitor({
      usage: usageStore,
      config: (workspaceId) => loadConfig(workspaceId),
      onAlert: async ({ session, threshold, live }) => {
        await channelPoster.post({
          workspaceId: session.workspaceId,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          body:
            "Spend alert: session " +
            session.sessionId +
            " crossed " +
            threshold +
            "% of the workspace budget window (" +
            live.estimatedCostCents +
            "c estimated for this session).",
        });
      },
      onKill: async ({ session, live, reason }) => {
        await setKillSwitch(session.workspaceId, true, session.createdByMemberId);
        await channelPoster.post({
          workspaceId: session.workspaceId,
          channelId: session.channelId,
          agentMemberId: session.agentMemberId,
          body:
            "Spend guard engaged the workspace kill switch for session " +
            session.sessionId +
            ": " +
            reason +
            " (" +
            live.estimatedCostCents +
            "c estimated for this session).",
        });
      },
    }),
    // #69: fail fast on a misconfigured cloud/real-agent posture before any launch persists or makes
    // a cloud call. local/demo (the default) always passes, so this is a no-op for that posture.
    preflight: defaultPreflight,
    // Auto model-selection (convene-llm-gateway): undefined unless LLM_GATEWAY_URL is set. The resolver
    // gates itself further on the master switch + per-tenant config, so this is OFF by default.
    autoModel,
    // #246 model preflight: the workspace's owner-picked fleet model (Settings → Connect Claude → Model)
    // and the deployment default, so the launch gate validates the EFFECTIVE model against the models
    // known to resolve BEFORE spawning a real claude-code session — an unservable id (claude-fable-5)
    // throws an actionable ModelUnavailableError instead of crashing mid-run.
    modelForAgent: async (workspaceId: string, agentMemberId: string) =>
      (await getPersonaByAgentMember(workspaceId, agentMemberId))?.model ?? null,
    modelForWorkspace: (workspaceId: string) => getWorkspaceClaudeModel(workspaceId),
    envDefaultModel: process.env.ANTHROPIC_MODEL,
    // #230: route genuine session failures into the self-healing flywheel (see note above).
    onSessionFailure: async (e) => {
      // #242: a "model" misconfig is OWNER-actionable config (a `--model` the API can't serve), not a
      // harness crash a fix agent could repair — so it routes ONLY to a self-healing incident, never the
      // #117 auto-fix flywheel (which would spin a doomed fix session against an unfixable-by-agent value).
      if (e.failureClass === "model") {
        try {
          await recordModelFailureIncident(selfHealingStore, {
            workspaceId: e.workspaceId,
            // The real cause (the redacted error excerpt) so the console names the unavailable model.
            detail: `${e.message}${e.errorExcerpt ? ` — ${e.errorExcerpt}` : ""} · session ${e.status} · exit ${e.exitCode ?? "n/a"}`,
            now: new Date(),
          });
        } catch (err: unknown) {
          logger.error({ err }, "model-incident recording failed");
        }
        return;
      }
      if (!failureFlywheel) {
        const { createDefaultFlywheelEngine } = await import("../flywheel/default.js");
        failureFlywheel = createDefaultFlywheelEngine(logger, manager);
      }
      await failureFlywheel.record({
        workspaceId: e.workspaceId,
        failureClass: "harness_crash",
        // #242: carry the real error excerpt so the fingerprinted record names the actual cause, not just
        // the generic headline + exit code.
        message: `${e.message} (${e.failureClass})`,
        source: "harness",
        detail: `session ${e.status} · exit ${e.exitCode ?? "n/a"}${e.errorExcerpt ? ` · ${e.errorExcerpt}` : ""}`,
        sessionId: e.sessionId,
        channelId: e.channelId,
        agentMemberId: e.agentMemberId,
      });
      // #238: a SPAWN cluster (exit n/a — a missing image tool / non-writable workspace root) ALSO
      // opens a self-healing OPS incident (#193). The flywheel writes `failure_fingerprints`; the
      // console's `selfHealingOps` pane reads `self_healing_remediations` — so without this the pane
      // stayed 0 despite 21 real spawn failures. Best-effort: an incident hiccup never affects a session.
      if (e.failureClass === "spawn") {
        try {
          await recordSpawnFailureIncident(selfHealingStore, {
            workspaceId: e.workspaceId,
            detail: `${e.message} · session ${e.status} · exit ${e.exitCode ?? "n/a"}`,
            now: new Date(),
          });
        } catch (err: unknown) {
          logger.error({ err }, "spawn-incident recording failed");
        }
      }
    },
    // #238/#242: resolve the open agent-runtime spawn incident AND any open agent-model incident once a
    // real session completes — the production-grounded proof the runtime recovered (image patched) and the
    // model was corrected (a valid model selected / redeployed). Both are no-ops when nothing is open.
    onSessionRecovered: async (e) => {
      try {
        await resolveSpawnFailureIncident(selfHealingStore, e.workspaceId, new Date());
      } catch (err: unknown) {
        logger.error({ err }, "spawn-incident resolution failed");
      }
      try {
        await resolveModelFailureIncident(selfHealingStore, e.workspaceId, new Date());
      } catch (err: unknown) {
        logger.error({ err }, "model-incident resolution failed");
      }
    },
    // #248: a clean completion with real output SURFACES the deliverable as a board artifact so a briefed
    // task never "vanishes" (its result previously lived only as a channel message + `agent_sessions.result`
    // row the owner never saw). #243 single source of truth: the deliverable only PAUSES for the owner if it
    // spends money — a content draft debits nothing, so `requiresHumanApproval` is false and we surface it as
    // a DONE artifact (recorded `executed`) rather than parking it in the spend-approval lane awaiting a
    // needless yes. `agent.deliverable` grants no new authority: the executor is a pure acknowledgement and
    // publishing stays autonomous. The payload is STRUCTURAL data (#223 injection-safe — no agent-controlled
    // action type or amount). Best-effort: a surfacing error never affects the already-finalized session.
    onSessionCompleted: async (e) => {
      const task = e.task.trim();
      const headline = task.length > 80 ? `${task.slice(0, 79)}…` : task || "deliverable";
      // Rule-aware single source of truth: a content draft spends no money → autonomous by default, but a
      // cautious workspace can still opt `agent.deliverable` back into the spend-approval lane with a policy
      // rule. `evaluatePolicy` honors both the money predicate and any workspace rule (#243 / ADR-0013).
      const rules = await listPolicyRules(e.workspaceId);
      const gated = evaluatePolicy(
        { actionType: "agent.deliverable", amount: null },
        rules,
      ).requiresApproval;
      const payload = {
        sessionId: e.sessionId,
        channelId: e.channelId,
        task,
        computeSeconds: e.computeSeconds,
        estimatedCostCents: 0,
        // The draft is already redacted + bounded (the result tail). Stored so the drawer can show
        // what the agent produced without re-reading the channel.
        draft: e.result.slice(0, 4000),
      };
      const request = await createRequest({
        workspaceId: e.workspaceId,
        requesterMemberId: e.agentMemberId,
        actionType: "agent.deliverable",
        payload,
        amount: null,
        summary: `Deliverable ready for review: ${headline}`,
        // Non-money → autonomous: land it in Done (executed). Money (a future priced deliverable) → pending.
        status: gated ? "pending" : "executed",
        expiresAt: null,
        result: gated
          ? undefined
          : { acknowledged: true, sessionId: e.sessionId, autonomous: true },
        events: gated
          ? [{ type: "requested", detail: { sessionId: e.sessionId } }]
          : [
              { type: "requested", detail: { sessionId: e.sessionId } },
              { type: "executed", detail: { acknowledged: true, autonomous: true } },
            ],
      });
      // #403 autonomous publishing — the missing link: a non-money deliverable previously landed in "Done
      // (executed)" but the SHIP only ran on a HUMAN approval (approvals/runtime.ts), so the fleet's work was
      // recorded-and-acknowledged but NEVER actually published — the "everything waits for me" circle. Here
      // we ship it the moment it's done, with no owner in the loop. The dispatcher is SELF-GATING (returns
      // null unless delivery is enabled for the workspace + the department is shippable), so every workspace
      // without delivery enabled is byte-for-byte unchanged — only the owner workspace publishes autonomously.
      // Reversible by design (#200 §4 respected in spirit): site_pr opens a PR, it is not merged/live, so the
      // autonomous action can always be undone. Best-effort: a ship failure is logged and never affects the
      // already-finalized session or the recorded deliverable.
      if (!gated) {
        try {
          const shipped = await deliveryDispatcher(logger).ship(payload, {
            workspaceId: e.workspaceId,
            approvalRequestId: request.id,
            workerMemberId: e.agentMemberId,
          });
          if (shipped) {
            logger.info(
              {
                workspaceId: e.workspaceId,
                sessionId: e.sessionId,
                channel: shipped.channel ?? null,
              },
              "deliverable shipped autonomously",
            );
            // Make the autonomous ship VISIBLE in the console — the owner shouldn't have to read the GitHub
            // repo to know the fleet is producing. Post a short agent-authored line into the channel with the
            // live artifact url so it shows in the feed (answers "I don't see anything happening in the UI").
            // Best-effort: an announcement failure never affects the finalized session or the recorded ship.
            if (shipped.externalRef) {
              await channelPoster
                .post({
                  workspaceId: e.workspaceId,
                  channelId: e.channelId,
                  agentMemberId: e.agentMemberId,
                  body: `📤 Shipped autonomously → ${shipped.externalRef}`,
                })
                .catch((err: unknown) => logger.error({ err }, "ship-announcement post failed"));
            }
          }
        } catch (err: unknown) {
          logger.error({ err, sessionId: e.sessionId }, "autonomous deliverable ship failed");
        }
      }
    },
    // #393: post the agent's real deliverable as a chat MESSAGE into its own channel — the fleet's
    // visible reply — so a completed run isn't read as "no response" (it previously lived only as a
    // board card + result row). Gated by the EXISTING agent-channel-posting capability (#370, default-OFF,
    // owner-workspace-first, already ON for the owner workspace in prod): a non-owner / unset deployment
    // is a no-op and byte-for-byte unchanged. Authored as the agent member via the SAME `channelPoster`
    // the streamed output uses. Best-effort: a post error never affects the already-finalized session.
    postDeliverableMessage: async (e) => {
      if (!e.channelId) return;
      const caps = resolveAgentChannelPostingCaps(loadConfig(e.workspaceId).agentChannelPosting);
      if (
        !isAgentChannelPostingEnabledForWorkspace(caps, e.workspaceId) &&
        !(await isSyntheticSelfQaWorkspaceForAgentPosting(e.workspaceId))
      ) {
        return;
      }
      const body = formatDeliverableMessage(e.task, e.result);
      if (!body) return;
      await channelPoster.post({
        workspaceId: e.workspaceId,
        channelId: e.channelId,
        agentMemberId: e.agentMemberId,
        body,
      });
      // #417: after the deliverable is posted, fire the handoff hook so any @mentioned fleet teammate is
      // launched through the governed a2a path (the hook self-gates on `agentCollaboration`, default-OFF).
      // Scan the FULL `e.result`, NOT the posted `body`: `formatDeliverableMessage` length-caps the body from
      // the START (`slice(0, MAX_REPLY_CHARS)`), so a long deliverable whose "@quill …" hand-off sits at the
      // END would be truncated away before we scan it (observed live: mentions:[] despite an @mention in the
      // text). The full result is what `decideA2ACall.sanitizeTask` re-caps anyway. Best-effort: a hook
      // failure never throws into the already-finalized session.
      if (deliverableHandoffHook) {
        void deliverableHandoffHook({
          workspaceId: e.workspaceId,
          agentMemberId: e.agentMemberId,
          task: e.task,
          deliverable: e.result,
        }).catch(() => {
          /* best-effort handoff; the deliverable is already posted */
        });
      }
    },
  });
  return manager;
}
