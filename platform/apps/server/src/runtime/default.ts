import { loadEnv } from "../env.js";
import { loadConfig } from "../config/loader.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import { createGitWorkspaceFromEnv } from "../git/default.js";
import { GitWorkspaceProvisioner } from "../git/provisioner.js";
import {
  createAgentSession,
  finalizeSession,
  heartbeatSession,
  markSessionRunning,
} from "../db/repositories/agent-sessions.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import { createRuntime } from "./factory.js";
import { preflight, type PreflightReport } from "./preflight.js";
import {
  EnvSecretsResolver,
  ExternalSecretsResolver,
  ScopedSecretsResolver,
  SubscriptionSecretsResolver,
} from "./secrets-resolver.js";
import { resolveCredentialMatrix } from "./credential-scope.js";
import { getPersonaByAgentMember } from "../db/repositories/personas.js";
import { resolveOnboardingCaps } from "../onboarding/caps.js";
import { resolveAllServiceSecrets } from "../db/repositories/external-credentials.js";
import { createAgentAuthResolver } from "./auth-default.js";
import { SessionManager, type ChannelPoster, type SessionLogger, type SessionStore } from "./manager.js";
import { AutoModelResolver } from "./auto-model.js";
import { HttpGatewayRoutingClient } from "./gateway-client.js";
import { usageStore } from "../db/repositories/tenant-usage.js";
import { harnessLineDecoder } from "./stream-json.js";
import { harnessSpec, type HarnessKind } from "./harness.js";
import { createBraintrustTracer } from "../observability/braintrust.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { resolveBrowserCaps } from "./browser/caps.js";
import { createScale, type Scale } from "../scale/default.js";

/** Repository-backed session store (exported so integration tests reuse real persistence). */
export const dbStore: SessionStore = {
  create: createAgentSession,
  markRunning: markSessionRunning,
  heartbeat: heartbeatSession,
  finalize: finalizeSession,
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
  return preflight({
    profile: env.profile,
    runtime: env.runtime,
    harness: env.harness,
    env: process.env,
    browserEnabled,
  });
}

export function createDefaultSessionManager(logger: SessionLogger, scale: Scale = createScale(0)): SessionManager {
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
  const workspace: WorkspaceProvisioner = gitWorkspace
    ? new GitWorkspaceProvisioner(gitWorkspace)
    : new FileConfigWorkspaceProvisioner({ logger });
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
          isEnabled: (workspaceId) => resolveOnboardingCaps(loadConfig(workspaceId).onboarding).enabled,
          loadServiceSecrets: (workspaceId) => resolveAllServiceSecrets(workspaceId),
        }),
      ),
      {
        loadMatrix: (workspaceId) => resolveCredentialMatrix(loadConfig(workspaceId).credentialScopes),
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
    harnessOverrides: (kind: HarnessKind) => ({
      ...harnessSpec(kind, { claudeBin: process.env.CLAUDE_BIN, codexBin: process.env.CODEX_BIN }),
      decode: harnessLineDecoder(kind),
    }),
    caps: env.caps,
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
    // #69: fail fast on a misconfigured cloud/real-agent posture before any launch persists or makes
    // a cloud call. local/demo (the default) always passes, so this is a no-op for that posture.
    preflight: defaultPreflight,
    // Auto model-selection (convene-llm-gateway): undefined unless LLM_GATEWAY_URL is set. The resolver
    // gates itself further on the master switch + per-tenant config, so this is OFF by default.
    autoModel,
    // #230: route genuine session failures into the self-healing flywheel (see note above).
    onSessionFailure: async (e) => {
      if (!failureFlywheel) {
        const { createDefaultFlywheelEngine } = await import("../flywheel/default.js");
        failureFlywheel = createDefaultFlywheelEngine(logger, manager);
      }
      await failureFlywheel.record({
        workspaceId: e.workspaceId,
        failureClass: "harness_crash",
        message: `${e.message} (${e.failureClass})`,
        source: "harness",
        detail: `session ${e.status} · exit ${e.exitCode ?? "n/a"}`,
        sessionId: e.sessionId,
        channelId: e.channelId,
        agentMemberId: e.agentMemberId,
      });
    },
  });
  return manager;
}
