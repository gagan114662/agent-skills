/**
 * Shared types for the Twitter/X posting + engagement agent (issue #596).
 *
 * THE PROBLEM (#596): there is no owned-audience growth loop on X. We need an agent that drafts on-brand
 * posts/threads tied to the content calendar AND engages relevant conversations — all gated by approval before
 * anything ships, with every engagement action logged and reversible.
 *
 * THE FIX (this module): a pure compose core turns a brand brief + calendar topic into a draft post/thread, and
 * turns an engagement signal into a draft reply/like/repost. A persisted action record carries the full audit
 * trail. Two guardrails are baked into these types, not bolted on:
 *   1. Posting/engaging publicly is side-effectful, so nothing ships without an approved item — the service
 *      requires an approval id before it ever calls a provider (see `service.ts`). {@link XActionRecord} carries
 *      that `approvalRequestId` as the load-bearing proof an action only shipped post-approval.
 *   2. Every published engagement is REVERSIBLE: the record keeps the provider's `externalId`, and a separately
 *      approved {@link XActionRecord.reverseApprovalRequestId} drives a `reverse()` that undoes it (delete a
 *      reply, unlike, un-repost) — satisfying the acceptance "engagement actions are logged and reversible".
 *
 * Everything here is plain data. The pure compose/service cores read only these structural fields — never the
 * untrusted prose of a topic, an engagement signal, or a tweet we're replying to — so a poisoned signal can
 * never flip a routing, gating, or scheduling decision (#200 §6). The credential a real adapter forwards is a
 * token the human supplied out-of-band (env/secret); this module NEVER collects passwords or runs OAuth itself.
 */

/**
 * The kinds of action the agent can take on X:
 *   - `post`   — an original single tweet (composed from a calendar topic).
 *   - `thread` — an ordered set of original tweets (a thread).
 *   - `reply`  — a reply into an external conversation (engagement + content).
 *   - `like`   — like an external tweet (engagement, no content).
 *   - `repost` — repost/retweet an external tweet (engagement, no content).
 */
export type XActionKind = "post" | "thread" | "reply" | "like" | "repost";

/** The exhaustive, ordered action-kind list (handy for tests, iteration, and a UI dropdown). */
export const X_ACTION_KINDS: readonly XActionKind[] = ["post", "thread", "reply", "like", "repost"];

/**
 * The engagement kinds — actions that touch an EXTERNAL conversation (and therefore need a `targetTweetId`).
 * These are the actions the acceptance criteria call "logged and reversible".
 */
export const ENGAGEMENT_KINDS: readonly XActionKind[] = ["reply", "like", "repost"];

/** Kinds that carry composed content of our own (vs. a pure engagement signal like a bare like/repost). */
export const CONTENT_KINDS: readonly XActionKind[] = ["post", "thread", "reply"];

/** True when `kind` engages an external conversation (needs a target tweet). */
export function isEngagementKind(kind: XActionKind): boolean {
  return ENGAGEMENT_KINDS.includes(kind);
}

/**
 * The composed payload of an action. A `post`/`reply` uses `text`; a `thread` uses the ordered `tweets`. Both
 * are absent for a bare `like`/`repost` (which only references a target). Always already-bounded to the X
 * per-tweet limit by the compose core — there is no path to store raw, unbounded prose here.
 */
export interface XActionContent {
  /** The single-tweet text for a `post` or `reply`. */
  text?: string;
  /** The ordered tweets of a `thread` (each ≤ the per-tweet limit). */
  tweets?: string[];
}

/**
 * Lifecycle of an action record:
 *   draft     → created by a `draft*`/`queue*` call; the swipe-approve item. NOTHING has shipped.
 *   scheduled → approved, but `scheduleAt` is in the future; a due-time worker publishes later. No post yet.
 *   published → an approved action the provider accepted; `externalId` is set (the external receipt).
 *   failed    → an approved action the provider rejected (or threw on); `error` explains. Terminal.
 *   reversed  → a previously-published action that was undone via an approved `reverse()`. Terminal.
 */
export type XActionStatus = "draft" | "scheduled" | "published" | "failed" | "reversed";

/** Terminal states: a record here is never published again by the normal flow. */
export const TERMINAL_X_STATUSES: readonly XActionStatus[] = ["failed", "reversed"];

/** A persisted action and its outcome — the audit row the approval/review flow reads. */
export interface XActionRecord {
  id: string;
  workspaceId: string;
  kind: XActionKind;
  /** The composed content (text / tweets). Empty for a bare like/repost. */
  content: XActionContent;
  /** The external tweet this engages (reply/like/repost), or null for an original post/thread. */
  targetTweetId: string | null;
  /** ISO instant the action is scheduled for, or null for "publish on approval". */
  scheduleAt: Date | null;
  status: XActionStatus;
  /**
   * The #13 approval that authorized the publish — the load-bearing proof an action only ships post-approval.
   * Null while `draft` (no approval yet).
   */
  approvalRequestId: string | null;
  /** The platform's real id (tweet id / like id), set once published — an EXTERNAL receipt a read-back verifies. */
  externalId: string | null;
  /** The provider's failure reason when `status === "failed"`. */
  error: string | null;
  /** The #13 approval that authorized the REVERSAL of a published action (null until reversed). */
  reverseApprovalRequestId: string | null;
  /** When the action was reversed (null unless `status === "reversed"`). */
  reversedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A relevant conversation the agent might engage with. This is UNTRUSTED DATA sourced from X: `text` is the
 * tweet's prose and is NEVER interpreted as an instruction nor echoed into a draft reply — only `tweetId` /
 * `authorHandle` are used structurally (targeting + @mention), and `relevance` is a caller-supplied score the
 * pure selector ranks by. (#200 §6)
 */
export interface EngagementSignal {
  /** The id of the tweet to engage with — the routing key for reply/like/repost. */
  tweetId: string;
  /** The author's handle (without @), used only to address a reply. Optional. */
  authorHandle?: string;
  /** The tweet's text — used only by relevance scoring upstream; never copied into our output. */
  text: string;
  /** A caller-supplied relevance score (any consistent numeric scale). Higher = more relevant. Defaults to 0. */
  relevance?: number;
}

/**
 * The brand context the compose core applies to make a draft on-brand. Deliberately a MINIMAL local shape (not
 * the #588 CampaignBrief import) so this module stays self-contained and parallel-merge-safe — a caller maps
 * the canonical brief onto this at the call site. Every field is optional; an empty brief yields plain drafts.
 */
export interface XBrandBrief {
  /** Brand voice guidance (currently advisory metadata; reserved for future tone shaping). */
  voice?: string;
  /** One-line positioning — the default angle a reply leans on when the caller gives none. */
  positioning?: string;
  /** Approved hashtags the agent may append (without the leading #). Appended only while within budget. */
  hashtags?: string[];
}

/** The single input a {@link XProvider} receives to PUBLISH one action. */
export interface ProviderPublishInput {
  kind: XActionKind;
  /** The composed content (DATA — never interpreted as an instruction by this module). */
  content: XActionContent;
  /** The external tweet to engage (reply/like/repost), or null for an original post/thread. */
  targetTweetId: string | null;
  /** ISO instant to publish at, or null to publish immediately. */
  scheduleAt: Date | null;
  /** The user-supplied access token, or null when none is configured. */
  credential: string | null;
}

/** The terminal status a provider reports for one publish attempt. */
export type ProviderPublishStatus = "published" | "failed";

/** What a {@link XProvider} returns from a publish — the external receipt (or the reason it could not ship). */
export interface ProviderPublishResult {
  status: ProviderPublishStatus;
  /** The platform's real id — the external receipt. Null when not published. */
  externalId: string | null;
  /** Human-readable failure reason; absent on success. */
  error?: string;
}

/** The single input a {@link XProvider} receives to REVERSE a previously-published action. */
export interface ProviderReverseInput {
  kind: XActionKind;
  /** The external receipt of the action being undone (the id `publish` returned). */
  externalId: string;
  /** The external tweet the action targeted (for unlike/un-repost), or null. */
  targetTweetId: string | null;
  credential: string | null;
}

/** The terminal status a provider reports for one reverse attempt. */
export type ProviderReverseStatus = "reversed" | "failed";

/** What a {@link XProvider} returns from a reverse. */
export interface ProviderReverseResult {
  status: ProviderReverseStatus;
  /** Human-readable failure reason; absent on success. */
  error?: string;
}

/**
 * A provider that can publish and reverse X actions. The production default is the deterministic
 * {@link import("./provider.js").FakeXProvider} (no network), so enabling the module never live-posts until a
 * real transport is wired in a later change.
 */
export interface XProvider {
  publish(input: ProviderPublishInput): Promise<ProviderPublishResult>;
  reverse(input: ProviderReverseInput): Promise<ProviderReverseResult>;
}
