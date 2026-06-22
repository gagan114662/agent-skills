/**
 * Provider implementations for the community participation agent (issue #597).
 *
 * Two layers live here:
 *   1. {@link FakeCommunityProvider} — the deterministic sandbox adapter that is the production DEFAULT. It does
 *      no network IO: `findThreads` returns stable fixtures derived from the input, and `post` derives a stable
 *      fake external id. Enabling the module therefore exercises the whole discover → gate → queue → approve →
 *      post path WITHOUT ever live-fetching or live-posting. This is what makes "no live participation until
 *      enabled" structural rather than a promise.
 *   2. The three real adapters ({@link RedditAdapter}, {@link SlackAdapter}, {@link DiscordAdapter}). Each is a
 *      scaffold that forwards to an injected {@link CommunityTransport}. No transport is wired anywhere in this
 *      change set, so even with the master switch ON and a credential present, a real adapter discovers nothing
 *      ([]) and a post is a recorded no-op ("no transport configured"). A real adapter with NO credential is
 *      likewise a no-op ("no credentials") — never an OAuth attempt, since this module never collects passwords.
 */

import type {
  CommunityPlatform,
  CommunityProvider,
  CommunityThread,
  FindThreadsInput,
  ProviderPostInput,
  ProviderPostResult,
} from "./types.js";
import { COMMUNITY_PLATFORMS } from "./types.js";

/**
 * The network seam a real adapter would call. Intentionally NOT implemented or wired in this change set — its
 * absence is what guarantees no live participation ships here. A future change injects a concrete transport.
 */
export interface CommunityTransport {
  /** Fetch candidate threads for one platform. */
  search(input: FindThreadsInput): Promise<CommunityThread[]>;
  /** Post one reply, returning the platform's reply id. */
  reply(input: ProviderPostInput): Promise<{ externalId: string }>;
}

/** Deterministic FNV-1a → hex hash. Used so sandbox ids are stable for a given input (no RNG). */
function stableHash(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  const joined = parts.join(" ");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Deterministic sandbox provider — the production default. Never touches a network. `findThreads` returns a
 * stable set of fixture threads (one per community, with reproducible topics) and `post` returns a stable fake
 * external id. It ignores the credential by design (the sandbox needs none).
 */
export class FakeCommunityProvider implements CommunityProvider {
  constructor(public readonly platform: CommunityPlatform) {}

  async findThreads(input: FindThreadsInput): Promise<CommunityThread[]> {
    const threads: CommunityThread[] = [];
    for (const community of input.communities) {
      const seed = stableHash([this.platform, community]);
      // Derive a small, stable topic set so relevance is reproducible in the sandbox.
      const topics = ["ai", "marketing-automation", "growth"].slice(0, 1 + (parseInt(seed.slice(0, 1), 16) % 3));
      const lead = topics[0] ?? "ai";
      threads.push({
        id: `fake_${this.platform}_${seed}`,
        platform: this.platform,
        communityRef: community,
        title: `How are people handling ${lead} workflows?`,
        body: `Sandbox fixture thread for ${community}. No network was touched.`,
        url: `https://example.test/${this.platform}/${community}/${seed}`,
        ageHours: 1 + (parseInt(seed.slice(1, 3), 16) % 48),
        replyCount: parseInt(seed.slice(3, 4), 16) % 10,
        topics,
      });
      if (threads.length >= input.limit) break;
    }
    return threads;
  }

  async post(input: ProviderPostInput): Promise<ProviderPostResult> {
    const externalId = `fake_${input.platform}_${stableHash([
      input.platform,
      input.thread.id,
      input.body,
    ])}`;
    return { status: "posted", externalId };
  }
}

/**
 * Base class for the real adapters: a no-op unless BOTH a credential is supplied AND a transport is wired.
 * `findThreads` returns [] without a transport (it never live-fetches). `post` with no credential ⇒ `failed`
 * ("no credentials"); with a credential but no transport ⇒ `failed` ("no transport configured"). No path performs
 * IO, so nothing live-participates.
 */
abstract class RealAdapter implements CommunityProvider {
  abstract readonly platform: CommunityPlatform;
  constructor(protected readonly transport?: CommunityTransport) {}

  async findThreads(input: FindThreadsInput): Promise<CommunityThread[]> {
    if (!input.credential || !this.transport) return [];
    return this.transport.search(input);
  }

  async post(input: ProviderPostInput): Promise<ProviderPostResult> {
    if (!input.credential) {
      return { status: "failed", externalId: null, error: "no credentials" };
    }
    if (!this.transport) {
      return { status: "failed", externalId: null, error: "no transport configured" };
    }
    try {
      const { externalId } = await this.transport.reply(input);
      return { status: "posted", externalId };
    } catch (err) {
      return {
        status: "failed",
        externalId: null,
        error: err instanceof Error ? err.message : "post failed",
      };
    }
  }
}

/** Real Reddit adapter (scaffold; no live transport wired in this change set). */
export class RedditAdapter extends RealAdapter {
  readonly platform = "reddit" as const;
}

/** Real Slack adapter (scaffold; no live transport wired in this change set). */
export class SlackAdapter extends RealAdapter {
  readonly platform = "slack" as const;
}

/** Real Discord adapter (scaffold; no live transport wired in this change set). */
export class DiscordAdapter extends RealAdapter {
  readonly platform = "discord" as const;
}

/** A platform → provider registry the service routes through. */
export type ProviderRegistry = Record<CommunityPlatform, CommunityProvider>;

/**
 * The default registry: a {@link FakeCommunityProvider} for every platform. Deterministic and network-free — the
 * production binding uses this so enabling the module cannot live-fetch or live-post.
 */
export function createFakeProviderRegistry(): ProviderRegistry {
  return {
    reddit: new FakeCommunityProvider("reddit"),
    slack: new FakeCommunityProvider("slack"),
    discord: new FakeCommunityProvider("discord"),
  };
}

/**
 * A registry of the real adapters, optionally sharing one transport. Provided for completeness/wiring in a later
 * change; with no transport every adapter is a no-op, so this still cannot live-participate on its own.
 */
export function createRealProviderRegistry(transport?: CommunityTransport): ProviderRegistry {
  return {
    reddit: new RedditAdapter(transport),
    slack: new SlackAdapter(transport),
    discord: new DiscordAdapter(transport),
  };
}

/** Guard: is `value` one of the known platforms? Used to reject unknown routing keys structurally. */
export function isCommunityPlatform(value: string): value is CommunityPlatform {
  return (COMMUNITY_PLATFORMS as readonly string[]).includes(value);
}
