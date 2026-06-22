/**
 * The conversion data-source seam (issue #593). A source supplies the raw material the scorecard is built from:
 * conversion events (pipeline + revenue, attributed to an agent + channel) and current agent activity (touches).
 * In production this is where a CRM / analytics / billing feed would be read; the service ingests whatever the
 * source returns, dedupes it, and recomputes the scorecard.
 *
 * The shipped default is the deterministic {@link FakeConversionSource}, which calls NOTHING external — so until a
 * deployment both enables the scorecard AND wires a live source, no money is spent and no network request is made
 * (the conservative #741 `FakeAvatarProvider` / #272 dry-run posture). Its output is a pure function of the
 * workspace id, so tests and demos are reproducible.
 *
 * The contract is intentionally tiny: `fetch(workspaceId)` returns a {@link ConversionFeed}. A live source maps
 * its own records onto {@link ConversionEvent} / {@link AgentActivity}; the rest of the module never sees the
 * upstream shape.
 */

import type { AgentActivity, ConversionEvent } from "./types.js";

/** One pull from a source: the conversion events that have landed plus the latest activity snapshot. */
export interface ConversionFeed {
  events: ConversionEvent[];
  activities: AgentActivity[];
}

export interface ConversionSource {
  /** Source name, recorded for provenance (`"fake"` for the deterministic default). */
  readonly name: string;
  /** Whether this source reads a real (external) system. `false` for the deterministic fake. */
  readonly live: boolean;
  /** Pull the current conversion feed for a workspace. */
  fetch(workspaceId: string): Promise<ConversionFeed>;
}

/** A tiny deterministic string hash (FNV-1a/32) — same input, same number, no `Math.random`. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic integer in `[lo, hi]` derived from a seed string. */
function seededInt(seed: string, lo: number, hi: number): number {
  const span = hi - lo + 1;
  return lo + (hash32(seed) % span);
}

const FAKE_AGENTS = ["scout", "strategist", "writer", "distributor", "analyst"] as const;
const FAKE_CHANNELS = ["email", "ads", "social", "organic"] as const;

/** A fixed reference instant the fake source dates its events from, so the feed never depends on the wall clock. */
const FAKE_EPOCH = Date.UTC(2026, 0, 1);

/**
 * The production default: a deterministic, offline conversion source. For a given workspace it always returns the
 * same feed — a small, plausible spread of pipeline + revenue events across a handful of agents and channels,
 * plus matching activity — with ZERO external calls. This is what makes the whole feature safe to ship
 * default-ON-code / default-OFF-data: nothing leaves the process until a real source is deliberately wired.
 */
export class FakeConversionSource implements ConversionSource {
  readonly name = "fake";
  readonly live = false;

  async fetch(workspaceId: string): Promise<ConversionFeed> {
    const events: ConversionEvent[] = [];
    const activities: AgentActivity[] = [];

    FAKE_AGENTS.forEach((agentId, ai) => {
      // Each agent works two channels; the seed weaves in the workspace so different workspaces differ but are stable.
      const channelA = FAKE_CHANNELS[ai % FAKE_CHANNELS.length] ?? "email";
      const channelB = FAKE_CHANNELS[(ai + 1) % FAKE_CHANNELS.length] ?? "ads";

      const touchesA = seededInt(`${workspaceId}:${agentId}:tA`, 20, 120);
      const touchesB = seededInt(`${workspaceId}:${agentId}:tB`, 10, 80);
      activities.push({ agentId, channel: channelA, touches: touchesA });
      activities.push({ agentId, channel: channelB, touches: touchesB });

      // A couple of revenue (closed) events and a pipeline (opportunity) event per agent, scaled by a stable seed.
      const dealCount = seededInt(`${workspaceId}:${agentId}:deals`, 0, 3);
      for (let d = 0; d < dealCount; d += 1) {
        const amount = seededInt(`${workspaceId}:${agentId}:rev:${d}`, 1, 50) * 1000;
        events.push({
          eventId: `${workspaceId}:${agentId}:rev:${d}`,
          agentId,
          channel: d % 2 === 0 ? channelA : channelB,
          kind: "revenue",
          amountUsd: amount,
          customerId: `${workspaceId}:cust:${agentId}:${d}`,
          occurredAt: new Date(FAKE_EPOCH + seededInt(`${workspaceId}:${agentId}:revt:${d}`, 0, 60) * 86_400_000),
        });
      }
      const pipeAmount = seededInt(`${workspaceId}:${agentId}:pipe`, 5, 120) * 1000;
      events.push({
        eventId: `${workspaceId}:${agentId}:pipe`,
        agentId,
        channel: channelB,
        kind: "pipeline",
        amountUsd: pipeAmount,
        customerId: `${workspaceId}:cust:${agentId}:pipe`,
        occurredAt: new Date(FAKE_EPOCH + seededInt(`${workspaceId}:${agentId}:pipet`, 0, 60) * 86_400_000),
      });
    });

    return { events, activities };
  }
}

/**
 * An in-memory source seeded with a caller-supplied feed — for unit tests and demos that want to drive the service
 * with an exact, known set of events rather than the fake source's generated spread.
 */
export class StaticConversionSource implements ConversionSource {
  readonly name = "static";
  readonly live = false;
  constructor(private readonly feed: ConversionFeed) {}
  async fetch(): Promise<ConversionFeed> {
    return {
      events: this.feed.events.map((e) => ({ ...e })),
      activities: this.feed.activities.map((a) => ({ ...a })),
    };
  }
}
