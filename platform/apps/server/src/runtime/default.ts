import { loadEnv } from "../env.js";
import { loadConfig } from "../config/loader.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import { createGitWorkspaceFromEnv } from "../git/default.js";
import { GitWorkspaceProvisioner } from "../git/provisioner.js";
import {
  createAgentSession,
  finalizeSession,
  markSessionRunning,
} from "../db/repositories/agent-sessions.js";
import { postMessage } from "../db/repositories/messages.js";
import { publishMessageEvent } from "../realtime/bus.js";
import { createRuntime } from "./factory.js";
import { EnvSecretsResolver } from "./secrets-resolver.js";
import { SessionManager, type ChannelPoster, type SessionLogger, type SessionStore } from "./manager.js";
import { createBraintrustTracer } from "../observability/braintrust.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { createScale, type Scale } from "../scale/default.js";

/** Repository-backed session store (exported so integration tests reuse real persistence). */
export const dbStore: SessionStore = {
  create: createAgentSession,
  markRunning: markSessionRunning,
  finalize: finalizeSession,
};

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
    return { id: message.id };
  },
};

/**
 * Build the production SessionManager from env (#25). Default backend is `local`. The
 * `@vercel/sandbox` adapter is only constructed (and only loaded) when `AGENT_RUNTIME=sandbox`.
 */
export function createDefaultSessionManager(logger: SessionLogger, scale: Scale = createScale(0)): SessionManager {
  const env = loadEnv().agent;
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
  return new SessionManager({
    runtime: createRuntime(env, undefined, {
      size: serverScale.warmPoolSize,
      regions: serverScale.regions,
    }),
    store: dbStore,
    poster: channelPoster,
    secrets: new EnvSecretsResolver(),
    harness: { command: env.harnessCommand, args: env.harnessArgs },
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
  });
}
