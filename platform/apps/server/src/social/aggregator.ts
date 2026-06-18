/**
 * #269 — the connect-once SOCIAL AGGREGATOR provider seam. This is the bridge the issue asks for: the
 * customer connects ONCE (one consent through the #258 connect-once flow), and a single {@link publish}
 * call fans the post out to every target network. Per-network social APIs (X paid write tiers, LinkedIn
 * partner approval, Instagram/TikTok business requirements) are abstracted behind this one interface, so
 * Echo never touches a developer portal.
 *
 * Honoring the premortem (#200), exactly like the #258 connect-once provider:
 *   - §3 production-grounded: the DEFAULT {@link DryRunSocialAggregator} makes NO network call and never
 *     mints a real post — an unwired deployment posts nothing real (`live:false`). A real adapter is a
 *     deliberate future step behind connected credentials, never baked into the default path.
 *   - §2/§3 external receipts + read-back verification: {@link verify} re-reads the published post's
 *     per-network status + permalink from the aggregator's REAL API so success rests on a receipt we read
 *     back, never on the publish call's own optimistic response. The dry-run/mock doubles model this seam
 *     without a network.
 *   - §6 injection defense: the input `body` is opaque DATA passed straight through; the `networks` are a
 *     structural, already-validated allow-list (see `decide.ts`). The provider never interprets content.
 */

import type { SocialNetwork } from "./decide.js";

/** A per-network outcome from the aggregator — the externally-grounded receipt for one network. */
export interface SocialNetworkReceipt {
  network: SocialNetwork;
  /** `published` (live, has an external id), `scheduled` (accepted for a future time), or `failed`. */
  status: "published" | "scheduled" | "failed";
  /** The network's real post id — the EXTERNAL receipt (#200 §2). null ⇒ nothing landed. */
  externalId: string | null;
  /** The live, readable permalink to the post — read back to prove it published (#200 §3). null until known. */
  permalink: string | null;
  /** A human-readable failure reason when `status === "failed"`, else null. */
  error: string | null;
}

export interface AggregatorPublishInput {
  workspaceId: string;
  /** Opaque post content (DATA). */
  body: string;
  /** The already-validated target networks. */
  networks: readonly SocialNetwork[];
  /** Null ⇒ post now; otherwise the aggregator schedules the post at this ISO instant. */
  scheduledAt: string | null;
}

export interface AggregatorPublishResult {
  /** The aggregator's overall post id — the handle {@link SocialAggregatorProvider.verify} reads back. */
  aggregatorRef: string | null;
  /** One receipt per requested network. */
  receipts: SocialNetworkReceipt[];
}

export interface AggregatorVerifyResult {
  /** The re-read per-network receipts (permalinks resolved). Empty ⇒ the aggregator knows nothing of the ref. */
  receipts: SocialNetworkReceipt[];
}

export interface SocialAggregatorProvider {
  /** Provider kind (`dryrun` | `mock` | `ayrshare` | ...). */
  readonly kind: string;
  /** Whether this provider can publish a REAL post. The route/service read it to tell the honest truth. */
  readonly live: boolean;
  /** Fan a single post out to every target network in one call. */
  publish(input: AggregatorPublishInput): Promise<AggregatorPublishResult>;
  /** Re-read a published post's per-network status + permalinks to PROVE it landed (#200 §3). */
  verify(input: { workspaceId: string; aggregatorRef: string }): Promise<AggregatorVerifyResult>;
}

/** A small error so the route can map a provider failure to a friendly response instead of a 500. */
export class SocialAggregatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialAggregatorError";
  }
}

/** A deterministic, network-free id for the dry-run/mock paths (derived from a stable seed). */
function seededId(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// --------------------------------------------------------------------------------------------------
// The dry-run default — the CONSERVATIVE production default. No network egress, never a real post.
// --------------------------------------------------------------------------------------------------

/**
 * The default provider for every deployment until a real aggregator client is wired. It records the
 * INTENT (a stable, clearly-synthetic `dryrun:` ref) and returns per-network receipts WITHOUT a real
 * external id or permalink — so the service can never claim a live post. `live` is false, so every read
 * path tells the honest truth ("posting is rolling out / nothing was published for real").
 */
export class DryRunSocialAggregator implements SocialAggregatorProvider {
  readonly kind = "dryrun";
  readonly live = false;

  async publish(input: AggregatorPublishInput): Promise<AggregatorPublishResult> {
    const ref = `dryrun:${seededId(`${input.workspaceId}:${input.body}:${input.networks.join(",")}`)}`;
    const status = input.scheduledAt ? "scheduled" : "failed";
    const receipts: SocialNetworkReceipt[] = input.networks.map((network) => ({
      network,
      // Nothing is published for real: a scheduled dry-run is "scheduled" (no live post yet), an immediate
      // dry-run is "failed" with no external id (it never reached a network). Either way `externalId` is null.
      status,
      externalId: null,
      permalink: null,
      error: input.scheduledAt ? null : "dry-run: no social provider connected",
    }));
    return { aggregatorRef: ref, receipts };
  }

  async verify(): Promise<AggregatorVerifyResult> {
    // A dry-run ref resolves to nothing real to read back.
    return { receipts: [] };
  }
}

// --------------------------------------------------------------------------------------------------
// The mock provider — a TEST/DEMO double. Returns clearly-synthetic, non-secret ids + permalinks so the
// publish → verify (read-back) path is exercisable end-to-end WITHOUT a real aggregator account or network.
// It is never selected by createSocialAggregator; tests/demos construct it explicitly.
// --------------------------------------------------------------------------------------------------

export class MockSocialAggregator implements SocialAggregatorProvider {
  readonly kind = "mock";
  readonly live = true;
  /** Networks the mock should FAIL (to exercise partial-success), by network id. */
  constructor(private readonly opts: { failNetworks?: readonly SocialNetwork[] } = {}) {}

  async publish(input: AggregatorPublishInput): Promise<AggregatorPublishResult> {
    const fail = new Set(this.opts.failNetworks ?? []);
    const ref = `mock:${seededId(`${input.workspaceId}:${input.body}:${input.networks.join(",")}`)}`;
    const receipts: SocialNetworkReceipt[] = input.networks.map((network) => {
      if (fail.has(network)) {
        return { network, status: "failed" as const, externalId: null, permalink: null, error: "mock failure" };
      }
      const externalId = `${network}_${seededId(`${ref}:${network}`)}`;
      if (input.scheduledAt) {
        return { network, status: "scheduled" as const, externalId, permalink: null, error: null };
      }
      return {
        network,
        status: "published" as const,
        externalId,
        // The publish call returns the id; the permalink is resolved on read-back (verify), modeling reality.
        permalink: null,
        error: null,
      };
    });
    return { aggregatorRef: ref, receipts };
  }

  async verify(input: { workspaceId: string; aggregatorRef: string }): Promise<AggregatorVerifyResult> {
    // Re-derive the same receipts and resolve their permalinks — the read-back proof.
    const receipts: SocialNetworkReceipt[] = [];
    for (const network of ["x", "linkedin", "instagram", "tiktok", "facebook"] as const) {
      const externalId = `${network}_${seededId(`${input.aggregatorRef}:${network}`)}`;
      receipts.push({
        network,
        status: "published",
        externalId,
        permalink: `https://mock.social.local/${network}/${externalId}`,
        error: null,
      });
    }
    return { receipts };
  }
}

// --------------------------------------------------------------------------------------------------
// The live factory — returns a real client ONLY when one is configured, else the dry-run default. No live
// client is wired in this slice, so every real deployment resolves to dry-run (honest, posts nothing real).
// A per-aggregator follow-up supplies a real client behind this same call.
// --------------------------------------------------------------------------------------------------

export interface SocialAggregatorClient {
  publish(input: AggregatorPublishInput): Promise<AggregatorPublishResult>;
  verify(input: { workspaceId: string; aggregatorRef: string }): Promise<AggregatorVerifyResult>;
}

/**
 * Pick the provider for a workspace: a live client when one is supplied, else the dry-run default. Returning
 * the same provider the service reads `live` from means the offer ("posting is on" vs "rolling out") and
 * what actually happens can never disagree. No live client is wired here, so this returns the dry-run
 * default everywhere — the real aggregator (e.g. Ayrshare) is a deliberate, owner-gated follow-up.
 */
export function createSocialAggregator(input: { client?: SocialAggregatorClient | null }): SocialAggregatorProvider {
  if (!input.client) return new DryRunSocialAggregator();
  const { client } = input;
  return {
    kind: "live",
    live: true,
    publish: (i) => client.publish(i),
    verify: (i) => client.verify(i),
  };
}
