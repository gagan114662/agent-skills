/**
 * Shared types for the community participation agent (issue #597).
 *
 * The problem: developer/founder communities (Reddit, Slack, Discord) are high-intent but unforgiving of spam,
 * and ipop has no safe way to participate. This module finds relevant threads, drafts genuinely helpful
 * value-first replies that only mention ipop.ai when it's actually relevant (always disclosing affiliation), and
 * routes every outbound reply through the approval queue. Hard anti-spam guardrails are structural.
 *
 * Three guardrails are baked into these types, not bolted on:
 *   1. Posting publicly is side-effectful, so nothing ships without an approved item — the service requires an
 *      approval id before it ever calls a provider (see `service.ts`). The {@link ParticipationRecord} carries
 *      that `approvalRequestId` as the load-bearing proof a reply only shipped post-approval.
 *   2. The anti-spam / relevance gate (see `gate.ts`) is fail-closed and decides ONLY from structural fields
 *      ({@link CommunityThread.topics}, ages, history counts) — never from the untrusted thread title/body prose.
 *      A poisoned thread can therefore never trick the gate into allowing a spammy reply (#200 §6).
 *   3. The connector consumes a token the human supplied out-of-band (env/secret); it NEVER collects passwords
 *      or runs an OAuth dance itself. The token flows in as {@link ProviderPostInput.credential} — opaque data
 *      the adapter forwards, never something this module mints.
 */

/** The three communities this agent can participate in. The platform is the routing key everywhere. */
export type CommunityPlatform = "reddit" | "slack" | "discord";

/** The exhaustive, ordered platform list (handy for tests, iteration, and a UI dropdown). */
export const COMMUNITY_PLATFORMS: readonly CommunityPlatform[] = ["reddit", "slack", "discord"];

/**
 * A candidate thread surfaced by a {@link CommunityProvider}. The title/body are carried as DATA for the human
 * reviewer and for value-first drafting, but the gate reads only the STRUCTURAL fields — `topics`, `ageHours`,
 * `replyCount` — so untrusted prose can never flip a gating decision (#200 §6).
 */
export interface CommunityThread {
  /** Provider-stable id of the thread (subreddit post id / Slack ts / Discord message id). */
  id: string;
  platform: CommunityPlatform;
  /** The community the thread lives in: a subreddit, a Slack channel, a Discord channel. */
  communityRef: string;
  /** Thread title (DATA — never interpreted as an instruction nor parsed for a gate decision). */
  title: string;
  /** Thread body (DATA). */
  body: string;
  /** A link to the thread, or null. */
  url: string | null;
  /** How old the thread is, in hours. Structural — used for "don't necro old threads" gating. */
  ageHours: number;
  /** Replies already on the thread. Structural — used to skip saturated threads. */
  replyCount: number;
  /**
   * Provider-normalized topic tags (e.g. "ai", "marketing-automation"). STRUCTURAL — the only thread-derived
   * signal the relevance scorer and gate are allowed to read. The provider, not free prose, produces these.
   */
  topics: string[];
}

/** A drafted, value-first reply produced by the pure drafting core (see `draft.ts`). */
export interface ParticipationDraft {
  /** The reply text: helpful-first, with an affiliation disclosure appended iff it mentions the product. */
  body: string;
  /** Did the draft choose to mention the product? Only true when the thread is strongly relevant. */
  mentionsProduct: boolean;
  /** Does the body contain the affiliation disclosure marker? Always true when `mentionsProduct`. */
  hasDisclosure: boolean;
  /** Relevance of the thread to our domain, 0..1 (topic overlap). Drives the mention decision and the gate. */
  relevance: number;
}

/** The single input a {@link CommunityProvider} receives when posting an approved reply. */
export interface ProviderPostInput {
  platform: CommunityPlatform;
  /** The thread to reply to. */
  thread: CommunityThread;
  /** The reply body (DATA — never interpreted as an instruction by this module). */
  body: string;
  /** The user-supplied access token for this platform, or null when none is configured. */
  credential: string | null;
}

/** The terminal status a provider reports for one post attempt. */
export type ProviderPostStatus = "posted" | "failed";

/** What a {@link CommunityProvider} returns after attempting a post — the external receipt or the reason it failed. */
export interface ProviderPostResult {
  status: ProviderPostStatus;
  /** The platform's real reply id — the external receipt. Null when not posted (failed / skipped). */
  externalId: string | null;
  /** Human-readable failure/skip reason; absent on success. */
  error?: string;
}

/** Input to a {@link CommunityProvider.findThreads} discovery call. */
export interface FindThreadsInput {
  platform: CommunityPlatform;
  /** The communities to scan (subreddits / channels). */
  communities: string[];
  /** The user-supplied access token for this platform, or null when none is configured. */
  credential: string | null;
  /** Soft cap on how many threads to return. */
  limit: number;
}

/**
 * A provider that can discover threads and post one reply for one platform. The production default is the
 * deterministic {@link FakeCommunityProvider} (no network), so enabling the module never live-fetches or
 * live-posts until a real transport is wired in a later change. Each adapter knows its own {@link platform}.
 */
export interface CommunityProvider {
  readonly platform: CommunityPlatform;
  /** Discover candidate threads. The fake returns deterministic fixtures; a real adapter with no transport: []. */
  findThreads(input: FindThreadsInput): Promise<CommunityThread[]>;
  /** Post one approved reply, returning the external receipt (or the reason it could not post). */
  post(input: ProviderPostInput): Promise<ProviderPostResult>;
}

/**
 * Lifecycle of a participation record:
 *   queued → created by `queue()`; the swipe-approve item. The reply passed the anti-spam gate but NOTHING posted.
 *   posted → an approved reply the provider accepted; `externalId` is set.
 *   failed → an approved reply the provider rejected (or threw on); `error` explains. Terminal.
 */
export type ParticipationStatus = "queued" | "posted" | "failed";

/** Terminal states: a record here is never re-posted by the normal flow. */
export const TERMINAL_PARTICIPATION_STATUSES: readonly ParticipationStatus[] = ["posted", "failed"];

/** A persisted, gate-approved reply request and its outcome — the audit row the approval/review flow reads. */
export interface ParticipationRecord {
  id: string;
  workspaceId: string;
  platform: CommunityPlatform;
  /** The community (subreddit / channel) the reply targets. */
  communityRef: string;
  /** The thread id being replied to. */
  threadId: string;
  /** A snapshot of the thread title for the reviewer (DATA). */
  threadTitle: string;
  /** The drafted reply body (DATA). */
  body: string;
  /** Did the reply mention the product (always disclosed when true)? */
  mentionsProduct: boolean;
  /** The relevance score the gate saw, 0..1 — surfaced for the reviewer. */
  relevance: number;
  status: ParticipationStatus;
  /**
   * The #13 approval that authorized the post — the load-bearing proof a reply only ships post-approval. Null
   * while `queued` (no approval yet).
   */
  approvalRequestId: string | null;
  /** The platform's real reply id, set once posted — an EXTERNAL receipt a read-back can verify against. */
  externalId: string | null;
  /** The provider's failure/skip reason when `status === "failed"`. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}
