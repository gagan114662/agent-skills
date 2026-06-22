/**
 * Shared types for the social publishing connectors module (issue #742).
 *
 * The problem: generating short-form video is worthless without distribution, but ipop has no path to push an
 * asset to TikTok, Instagram Reels, or YouTube Shorts. This module adds a publishing core with ONE provider
 * interface and three platform adapters, all behind a hard approval gate.
 *
 * Two guardrails are baked into these types, not bolted on:
 *   1. Posting publicly is side-effectful, so nothing ships without an approved item — the service requires an
 *      approval id before it ever calls a provider (see `service.ts`). The {@link PublishRecord} carries that
 *      `approvalRequestId` as the load-bearing proof a post only shipped post-approval.
 *   2. The connector consumes a token the human supplied out-of-band (env/secret); it NEVER collects passwords
 *      or runs an OAuth dance itself. The token flows in as {@link ProviderPublishInput.credential} — opaque
 *      data the adapter forwards, never something this module mints.
 *
 * Everything here is plain data. The pure service core reads only these structural fields — never untrusted
 * caption/asset prose — so a poisoned caption can never flip a routing or gating decision (#200 §6).
 */

/** The three short-form platforms this module can publish to. The platform is the routing key everywhere. */
export type SocialPlatform = "tiktok" | "instagram_reels" | "youtube_shorts";

/** The exhaustive, ordered platform list (handy for tests, iteration, and a UI dropdown). */
export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  "tiktok",
  "instagram_reels",
  "youtube_shorts",
];

/** A reference to the rendered video asset to publish. The `ref` is a pointer (asset id / URL), never bytes. */
export interface PublishAsset {
  /** Stable reference to the rendered asset (e.g. a #633 deliverable id or a storage URL). */
  ref: string;
  /** Optional MIME hint for the adapter (e.g. "video/mp4"). */
  mimeType?: string | null;
  /** Optional duration in seconds, for platform length validation. */
  durationSeconds?: number | null;
}

/**
 * The single input a {@link PublishProvider} receives. Mirrors the issue's interface
 * `publish({ platform, asset, caption, scheduleAt })`, plus the user-supplied credential token the adapter
 * forwards. `scheduleAt` is null for "publish now"; a future instant means "schedule".
 */
export interface ProviderPublishInput {
  platform: SocialPlatform;
  asset: PublishAsset;
  /** The post caption (DATA — never interpreted as an instruction by this module). */
  caption: string;
  /** ISO instant to publish at, or null to publish immediately. */
  scheduleAt: Date | null;
  /** The user-supplied access token for this platform, or null when none is configured. */
  credential: string | null;
}

/** The terminal status a provider reports for one publish attempt. */
export type ProviderPublishStatus = "published" | "scheduled" | "failed";

/** What a {@link PublishProvider} returns — the external receipt (or the reason it could not post). */
export interface ProviderPublishResult {
  status: ProviderPublishStatus;
  /** The platform's real post id — the external receipt. Null when not published (failed / skipped). */
  externalId: string | null;
  /** Human-readable failure/skip reason; absent on success. */
  error?: string;
}

/**
 * A provider that can publish one asset to one platform. The production default is the deterministic
 * {@link FakePublishProvider} (no network), so enabling the module never live-posts until a real transport is
 * wired in a later change. Each adapter knows its own {@link platform}.
 */
export interface PublishProvider {
  readonly platform: SocialPlatform;
  publish(input: ProviderPublishInput): Promise<ProviderPublishResult>;
}

/**
 * Lifecycle of a publish record:
 *   queued    → created by `queue()`; the swipe-approve item. NOTHING has posted.
 *   scheduled → approved, but `scheduleAt` is in the future; a due-time worker will publish later. No post yet.
 *   published → an approved publish that the provider accepted; `externalId` is set.
 *   failed    → an approved publish the provider rejected (or threw on); `error` explains. Terminal.
 */
export type PublishStatus = "queued" | "scheduled" | "published" | "failed";

/** Terminal states: a record here is never re-published by the normal flow. */
export const TERMINAL_PUBLISH_STATUSES: readonly PublishStatus[] = ["published", "failed"];

/** A persisted publish request and its outcome — the audit row the approval/review flow reads. */
export interface PublishRecord {
  id: string;
  workspaceId: string;
  platform: SocialPlatform;
  asset: PublishAsset;
  /** The caption (DATA). */
  caption: string;
  /** ISO instant the post is scheduled for, or null for "publish on approval". */
  scheduleAt: Date | null;
  status: PublishStatus;
  /**
   * The #13 approval that authorized the publish — the load-bearing proof a post only ships post-approval. Null
   * while `queued` (no approval yet).
   */
  approvalRequestId: string | null;
  /** The platform's real post id, set once published — an EXTERNAL receipt a read-back can verify against. */
  externalId: string | null;
  /** The provider's failure/skip reason when `status === "failed"`. */
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}
