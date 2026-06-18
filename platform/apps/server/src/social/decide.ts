/**
 * #269 Echo social posting via a connect-once aggregator bridge — the PURE decision core. Echo drafts a
 * post once, the bridge fans it out to every connected network (X, LinkedIn, Instagram, TikTok, Facebook)
 * through ONE connection (the customer connects once, never touches a developer portal — issue #269). This
 * file decides *whether the feature is on for a workspace*, *whether a post request is well-formed*, the
 * *per-network preview*, and *how a fan-out outcome maps to externally-verified receipts* — no IO, no
 * network, no DB.
 *
 * The premortem (#200) invariants that live here:
 *   - §6 injection defense: a post's `body` is opaque DATA. {@link decideSocialPost} reads it ONLY for
 *     emptiness + length; the target networks are a STRUCTURAL field (validated against the allow-list),
 *     never parsed out of the body. A poisoned read folded into the body can never retarget the fan-out,
 *     add a network, or flip a flag.
 *   - §4 reversibility: a published post is IRREVERSIBLE (a sent post cannot be un-sent). That is why
 *     publishing ALWAYS pauses for the owner (the always-gate is enforced in the service, not here) — the
 *     pre-commitment constraint the premortem demands for an irreversible action.
 *   - §3 production-grounded verification + §2 external receipts: {@link mapFanOutToReceipts} counts a
 *     network as genuinely `published` ONLY when the aggregator returned a real external post id — a
 *     self-reported "ok" with no receipt is treated as `failed`, never as success.
 *   - §4/§5 default-OFF, owner-workspace-first: {@link resolveSocialFlags} mirrors the #295/#266 resolver,
 *     so a fresh deployment posts nothing until an owner opts the owner workspace in.
 */

import type { SocialNetworkReceipt } from "./aggregator.js";

// --------------------------------------------------------------------------------------------------
// Networks the aggregator bridge fans out to + their per-network limits (for the preview).
// --------------------------------------------------------------------------------------------------

/** The networks the connect-once bridge can fan a single post out to. Structural — never parsed from content. */
export const SUPPORTED_NETWORKS = ["x", "linkedin", "instagram", "tiktok", "facebook"] as const;
export type SocialNetwork = (typeof SUPPORTED_NETWORKS)[number];

/**
 * Per-network character limits, used ONLY to build an honest preview (over-limit is flagged, never silently
 * truncated on publish — the post body is the source of truth; truncation is a preview convenience).
 */
export const NETWORK_LIMITS: Readonly<Record<SocialNetwork, number>> = {
  x: 280,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  facebook: 63206,
};

export function isSupportedNetwork(value: unknown): value is SocialNetwork {
  return typeof value === "string" && (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

/** A generous global cap on a post body — a guard against an unbounded paste, not a per-network limit. */
export const MAX_POST_BODY_LEN = 8000;

// --------------------------------------------------------------------------------------------------
// Feature flags — default-OFF, owner-workspace-first (mirrors #295 / #266).
// --------------------------------------------------------------------------------------------------

export interface SocialFlags {
  /** Master: is the social aggregator bridge usable for this workspace at all? */
  readonly enabled: boolean;
}

export const SOCIAL_FLAGS_OFF: SocialFlags = { enabled: false };

export interface SocialConfigInput {
  enabled?: boolean;
  /** Restrict posting to the owner workspace until proven (default true). */
  ownerWorkspaceOnly?: boolean;
  ownerWorkspaceId?: string;
}

/**
 * Resolve the social-posting flags for a workspace. DEFAULT OFF: unless `enabled === true` AND (the
 * workspace is the owner workspace OR `ownerWorkspaceOnly` was explicitly disabled), posting is off. A
 * byte-for-byte copy of the #295 delivery / #266 hosted resolver so the safety property is identical and
 * obvious: turning the feature on without naming the owner workspace posts for NObody.
 */
export function resolveSocialFlags(
  config: SocialConfigInput | undefined,
  workspaceId: string,
): SocialFlags {
  if (!config || config.enabled !== true) return SOCIAL_FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  const inScope = ownerOnly
    ? config.ownerWorkspaceId !== undefined && config.ownerWorkspaceId === workspaceId
    : true;
  if (!inScope) return SOCIAL_FLAGS_OFF;
  return { enabled: true };
}

// --------------------------------------------------------------------------------------------------
// Post request validation — body is DATA, networks are structural.
// --------------------------------------------------------------------------------------------------

export interface SocialPostRequest {
  /** The post content. Opaque DATA — read only for emptiness + length, NEVER parsed for routing. */
  body: string;
  /** The target networks (structural). Validated against {@link SUPPORTED_NETWORKS}; deduped; order-stable. */
  networks: string[];
  /** Optional ISO-8601 instant to schedule the post at; absent/empty ⇒ post immediately on approval. */
  scheduledAt?: string | null;
}

export interface SocialPostPlan {
  ok: true;
  body: string;
  networks: SocialNetwork[];
  /** Normalized schedule: a future ISO instant, or null for "post now". */
  scheduledAt: string | null;
}

export interface SocialPostRejection {
  ok: false;
  reason: string;
}

/**
 * Validate a post request and normalize it. Reads `body` ONLY for emptiness + length; the networks are a
 * structural allow-listed field (deduped, order-preserving). A `scheduledAt`, when present, must parse to a
 * real instant strictly in the future relative to `now`. Total + pure (the clock is injected).
 *
 * Injection defense (#200 §6): nothing about the routing/targets is derived from `body`.
 */
export function decideSocialPost(
  req: SocialPostRequest,
  opts: { now: Date },
): SocialPostPlan | SocialPostRejection {
  const body = (req.body ?? "").trim();
  if (body.length === 0) return { ok: false, reason: "post body is required" };
  if (body.length > MAX_POST_BODY_LEN) {
    return { ok: false, reason: `post body too long (max ${MAX_POST_BODY_LEN})` };
  }

  if (!Array.isArray(req.networks) || req.networks.length === 0) {
    return { ok: false, reason: "at least one target network is required" };
  }
  const networks: SocialNetwork[] = [];
  for (const n of req.networks) {
    if (!isSupportedNetwork(n)) return { ok: false, reason: `unsupported network: ${String(n)}` };
    if (!networks.includes(n)) networks.push(n);
  }

  let scheduledAt: string | null = null;
  if (req.scheduledAt !== undefined && req.scheduledAt !== null && req.scheduledAt.trim().length > 0) {
    const at = new Date(req.scheduledAt);
    if (Number.isNaN(at.getTime())) return { ok: false, reason: "scheduledAt is not a valid timestamp" };
    if (at.getTime() <= opts.now.getTime()) {
      return { ok: false, reason: "scheduledAt must be in the future" };
    }
    scheduledAt = at.toISOString();
  }

  return { ok: true, body, networks, scheduledAt };
}

// --------------------------------------------------------------------------------------------------
// Per-network preview — pure, derived from the (already-validated) body + targets.
// --------------------------------------------------------------------------------------------------

export interface NetworkPreview {
  network: SocialNetwork;
  /** The full post text as it would be sent (the body is never mutated on publish). */
  text: string;
  charCount: number;
  /** The network's character limit (for the UI to show "X / limit"). */
  limit: number;
  /** Whether the post fits this network's limit. */
  withinLimit: boolean;
  /** A convenience preview clipped to the limit (UI only — publish always sends the full body). */
  clippedText: string;
}

/**
 * Build a per-network preview for an already-validated body + target set. Pure + total. The text is the
 * literal body (no interpolation, no markup execution — it is rendered as data by the caller); `clippedText`
 * is a UI-only convenience and is NEVER what gets published.
 */
export function buildNetworkPreviews(body: string, networks: readonly SocialNetwork[]): NetworkPreview[] {
  return networks.map((network) => {
    const limit = NETWORK_LIMITS[network];
    const charCount = body.length;
    return {
      network,
      text: body,
      charCount,
      limit,
      withinLimit: charCount <= limit,
      clippedText: charCount <= limit ? body : body.slice(0, limit),
    };
  });
}

// --------------------------------------------------------------------------------------------------
// Fan-out → externally-verified receipts + overall status.
// --------------------------------------------------------------------------------------------------

/** The overall status of a post after a fan-out, derived ONLY from the per-network receipts. */
export const SOCIAL_POST_STATUSES = [
  "draft",
  "pending_approval",
  "scheduled",
  "published",
  "partially_published",
  "failed",
] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export function isSocialPostStatus(value: unknown): value is SocialPostStatus {
  return typeof value === "string" && (SOCIAL_POST_STATUSES as readonly string[]).includes(value);
}

/** The TERMINAL statuses a fan-out resolves to — the subset {@link summarizePostStatus} can return. */
export type TerminalPostStatus = "scheduled" | "published" | "partially_published" | "failed";

/**
 * Map raw aggregator receipts to the canonical, externally-grounded receipts (#200 §2/§3). A network is
 * only ever `published` when the aggregator returned a real external post id; a "published"-claimed receipt
 * with NO external id is downgraded to `failed` (a self-report without a receipt is not success). A
 * `scheduled` receipt is accepted as-is (its proof is the schedule id the aggregator returns). Pure + total.
 */
export function mapFanOutToReceipts(raw: readonly SocialNetworkReceipt[]): SocialNetworkReceipt[] {
  return raw.map((r) => {
    if (r.status === "published" && (!r.externalId || r.externalId.trim().length === 0)) {
      return { ...r, status: "failed", error: r.error ?? "no external post id returned" };
    }
    return { ...r };
  });
}

/**
 * Derive the overall post status from the verified per-network receipts. Fail-closed: an empty receipt set
 * is `failed`. Order of resolution: all-scheduled ⇒ `scheduled`; any published + any failed ⇒
 * `partially_published`; all published ⇒ `published`; none published ⇒ `failed`. Pure + total.
 */
export function summarizePostStatus(receipts: readonly SocialNetworkReceipt[]): TerminalPostStatus {
  if (receipts.length === 0) return "failed";
  const published = receipts.filter((r) => r.status === "published").length;
  const scheduled = receipts.filter((r) => r.status === "scheduled").length;
  const failed = receipts.filter((r) => r.status === "failed").length;
  if (scheduled === receipts.length) return "scheduled";
  if (published === 0) return "failed";
  if (failed > 0 || scheduled > 0) return "partially_published";
  return "published";
}
