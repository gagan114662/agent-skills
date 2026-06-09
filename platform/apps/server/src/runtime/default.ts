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
export function createDefaultSessionManager(logger: SessionLogger): SessionManager {
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
  return new SessionManager({
    runtime: createRuntime(env),
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
  });
}
