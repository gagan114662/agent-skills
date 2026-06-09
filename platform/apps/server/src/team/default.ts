import { loadEnv } from "../env.js";
import { listChannelMessages } from "../db/repositories/messages.js";
import { publishTeamEvent } from "../realtime/bus.js";
import { createBraintrustTracer } from "../observability/braintrust.js";
import { channelPoster } from "../runtime/default.js";
import type { SessionManager, SessionLogger } from "../runtime/manager.js";
import { TeamChannel } from "./channel.js";
import { TeamCoordinator } from "./coordinator.js";

/**
 * Build the production TeamCoordinator (Team Mode). It reuses the same SessionManager that powers
 * single-agent execution (#25) as its launcher, the #25 channel poster + #5 realtime bus for the
 * team channel, and the Braintrust tracer (a no-op unless BRAINTRUST_API_KEY is set). Max
 * concurrency comes from env (TEAM_MAX_CONCURRENCY, default 3).
 */
export function createDefaultTeamCoordinator(
  logger: SessionLogger,
  sessionManager: SessionManager,
): TeamCoordinator {
  const channel = new TeamChannel({
    poster: channelPoster,
    publish: (channelId, event) =>
      publishTeamEvent(channelId, event).catch(() => {
        /* best-effort realtime; the event is already persisted as a message */
      }),
    listMessages: listChannelMessages,
  });
  return new TeamCoordinator({
    launcher: sessionManager,
    channel,
    maxConcurrency: loadEnv().team.maxConcurrency,
    logger,
    tracer: createBraintrustTracer(),
  });
}
