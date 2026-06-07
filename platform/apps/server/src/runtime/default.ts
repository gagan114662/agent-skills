import { loadEnv } from "../env.js";
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
  return new SessionManager({
    runtime: createRuntime(env),
    store: dbStore,
    poster: channelPoster,
    secrets: new EnvSecretsResolver(),
    harness: { command: env.harnessCommand, args: env.harnessArgs },
    caps: env.caps,
    logger,
  });
}
