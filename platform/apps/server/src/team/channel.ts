import type { TeamEvent } from "@reload/shared";
import type { ChannelPoster } from "../runtime/manager.js";
import { encodeTeamEvent, tryParseTeamEvent } from "./protocol.js";

/**
 * Team Mode — the shared "team channel" protocol layer. Teammates keep each other in the loop by
 * posting structured {@link TeamEvent}s and reading peers' recent events before acting. This is a
 * thin adapter over the seams that already exist (#25 ChannelPoster + #5 realtime bus + the #4
 * message store) — it invents no new transport:
 *
 *   - `postEvent` persists the event as a channel message (REST is the source of truth) and
 *     best-effort publishes it on the realtime bus so connected peers see it live.
 *   - `readRecentEvents` lists the channel's messages and parses the team-event bodies back out,
 *     ignoring ordinary chatter — this is how a peer catches up before it starts work.
 */
export interface TeamChannelDeps {
  /** Persists a message authored by the agent member (reused from the SessionManager). */
  poster: ChannelPoster;
  /** Best-effort realtime fan-out (publishTeamEvent). A Redis hiccup must never fail a run. */
  publish: (channelId: string, event: TeamEvent) => Promise<void>;
  /** Lists a channel's messages in chronological order (listChannelMessages). */
  listMessages: (channelId: string) => Promise<{ body: string }[]>;
}

export class TeamChannel {
  constructor(private readonly deps: TeamChannelDeps) {}

  /**
   * Broadcast a team event: persist it as a channel message (authored by the emitting agent) and
   * best-effort publish it on the realtime bus. Resolves once persisted; realtime is fire-safe.
   */
  async postEvent(input: {
    workspaceId: string;
    channelId: string;
    event: TeamEvent;
  }): Promise<void> {
    await this.deps.poster.post({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.event.agentMemberId,
      body: encodeTeamEvent(input.event),
    });
    // Best-effort live nudge; the event is already persisted so a Redis failure is non-fatal.
    await this.deps.publish(input.channelId, input.event).catch(() => {});
  }

  /**
   * Read the channel's recent team events (newest last), parsing out any non-team chatter. `limit`
   * keeps the most recent N events; omit it to read them all.
   */
  async readRecentEvents(
    channelId: string,
    opts: { limit?: number } = {},
  ): Promise<TeamEvent[]> {
    const messages = await this.deps.listMessages(channelId);
    const events: TeamEvent[] = [];
    for (const m of messages) {
      const event = tryParseTeamEvent(m.body);
      if (event) events.push(event);
    }
    if (opts.limit !== undefined && events.length > opts.limit) {
      return events.slice(events.length - opts.limit);
    }
    return events;
  }
}
