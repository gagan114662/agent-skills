/**
 * Provider implementations for the X agent (issue #596).
 *
 * Two layers live here:
 *   1. {@link FakeXProvider} — the deterministic sandbox adapter that is the production DEFAULT. It does no
 *      network IO and derives a stable `externalId` from the input, so enabling the module exercises the whole
 *      draft → approve → publish → record (and reverse) path WITHOUT ever live-posting. This is what makes "no
 *      live posting until enabled" structural rather than a promise.
 *   2. {@link RealXAdapter} — a scaffold that forwards to an injected {@link XTransport}. No transport is wired
 *      anywhere in this change set, so even with the master switch ON and a credential present, the real adapter
 *      returns a no-op failure ("no transport configured") and posts nothing. A later, separately-reviewed
 *      change supplies the transport. A real adapter with NO credential is likewise a no-op ("no credentials") —
 *      never an OAuth attempt, since this module never collects passwords (the issue's guardrail).
 */

import type {
  ProviderPublishInput,
  ProviderPublishResult,
  ProviderReverseInput,
  ProviderReverseResult,
  XProvider,
} from "./types.js";

/**
 * The network seam a real adapter would call. Intentionally NOT implemented or wired in this change set — its
 * absence is what guarantees no live posting ships here. A future change injects a concrete transport.
 */
export interface XTransport {
  /** Perform the real post/engagement, returning the platform's id (tweet id / like id). */
  send(input: ProviderPublishInput): Promise<{ externalId: string }>;
  /** Undo a previously-sent action (delete a tweet/reply, unlike, un-repost). */
  undo(input: ProviderReverseInput): Promise<void>;
}

/** Deterministic FNV-1a → hex hash. Used so the sandbox `externalId` is stable for a given input (no RNG). */
export function stableHash(parts: readonly string[]): string {
  let h = 0x811c9dc5;
  const joined = parts.join(" ");
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A compact, order-stable fingerprint of an action's content for the deterministic fake external id. */
function fingerprint(input: ProviderPublishInput): string {
  const content =
    input.content.tweets && input.content.tweets.length > 0
      ? input.content.tweets.join("¶")
      : input.content.text ?? "";
  return stableHash([
    input.kind,
    input.targetTweetId ?? "",
    content,
    input.scheduleAt ? input.scheduleAt.toISOString() : "now",
  ]);
}

/**
 * Deterministic sandbox provider — the production default. Never touches a network. `publish` returns
 * `published` with a stable, reproducible fake id derived from the input; `reverse` always succeeds. It ignores
 * the credential by design (the sandbox needs none).
 */
export class FakeXProvider implements XProvider {
  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    return { status: "published", externalId: `fake_${input.kind}_${fingerprint(input)}` };
  }

  async reverse(_input: ProviderReverseInput): Promise<ProviderReverseResult> {
    return { status: "reversed" };
  }
}

/**
 * Real X adapter: a no-op unless BOTH a credential is supplied AND a transport is wired. With no credential ⇒
 * `failed` ("no credentials"); with a credential but no transport ⇒ `failed` ("no transport configured").
 * Neither path performs IO, so nothing live-posts in this change set. Reverse follows the same gating.
 */
export class RealXAdapter implements XProvider {
  constructor(private readonly transport?: XTransport) {}

  async publish(input: ProviderPublishInput): Promise<ProviderPublishResult> {
    if (!input.credential) return { status: "failed", externalId: null, error: "no credentials" };
    if (!this.transport) return { status: "failed", externalId: null, error: "no transport configured" };
    try {
      const { externalId } = await this.transport.send(input);
      return { status: "published", externalId };
    } catch (err) {
      return { status: "failed", externalId: null, error: err instanceof Error ? err.message : "publish failed" };
    }
  }

  async reverse(input: ProviderReverseInput): Promise<ProviderReverseResult> {
    if (!input.credential) return { status: "failed", error: "no credentials" };
    if (!this.transport) return { status: "failed", error: "no transport configured" };
    try {
      await this.transport.undo(input);
      return { status: "reversed" };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : "reverse failed" };
    }
  }
}

/**
 * The default provider: the deterministic sandbox. The production binding uses this so enabling the module
 * cannot live-post.
 */
export function createFakeXProvider(): XProvider {
  return new FakeXProvider();
}

/**
 * A real adapter, optionally sharing one transport. Provided for completeness/wiring in a later change; with no
 * transport it is a no-op, so this still cannot live-post on its own.
 */
export function createRealXProvider(transport?: XTransport): XProvider {
  return new RealXAdapter(transport);
}
