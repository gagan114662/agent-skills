/**
 * #266 ipop hosted publishing — the PURE decision core. ipop hosts a customer's blog + landing pages
 * multi-tenant (zero repo, zero deploy the user can see), served on the customer's own domain via the
 * #264 DNS flow or an ipop subdomain. This file decides *whether the feature is on for a workspace* and
 * *whether a publish request is well-formed* — no IO, no rendering, no DB.
 *
 * Two safety invariants live here (premortem #200):
 *   - §6 injection defense: a page's `body`/`title`/`description` are opaque DATA. `decideHostedPublish`
 *     reads them ONLY for emptiness and to derive a traversal-proof `slug` (charset `[a-z0-9-]`). It never
 *     parses content to choose a target, a domain, or an action — routing is structural (workspace/site).
 *   - §4/§5 default-OFF, owner-workspace-first: `resolveHostedSitesFlags` mirrors the #295 delivery flag
 *     resolver exactly, so a fresh deployment hosts nothing until an owner opts the owner workspace in.
 */

/** A hosted page is either a blog article or a standalone landing page. */
export const HOSTED_PAGE_KINDS = ["article", "landing"] as const;
export type HostedPageKind = (typeof HOSTED_PAGE_KINDS)[number];

export function isHostedPageKind(value: unknown): value is HostedPageKind {
  return typeof value === "string" && (HOSTED_PAGE_KINDS as readonly string[]).includes(value);
}

/**
 * The page lifecycle. `draft` is rendered + stored but not public; `pending_approval` is parked behind
 * the #13 owner gate (the HARD constraint: nothing goes live without an explicit owner approval);
 * `published` is live on the customer surface; `unpublished` is the reversible take-down (a published
 * page can always be pulled — premortem #200 §4 reversibility).
 */
export const HOSTED_PAGE_STATUSES = ["draft", "pending_approval", "published", "unpublished"] as const;
export type HostedPageStatus = (typeof HOSTED_PAGE_STATUSES)[number];

export function isHostedPageStatus(value: unknown): value is HostedPageStatus {
  return typeof value === "string" && (HOSTED_PAGE_STATUSES as readonly string[]).includes(value);
}

export const MAX_HOSTED_SLUG_LEN = 80;
export const MAX_HOSTED_TITLE_LEN = 200;

/** The traversal-proof slug charset — the security boundary for a page's public path (`/<slug>`). */
const HOSTED_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lowercase a free-form title into a safe `[a-z0-9-]` slug. Pure + total (empty in → empty out). */
export function slugifyHosted(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HOSTED_SLUG_LEN)
    .replace(/^-+|-+$/g, "");
}

/** A slug is valid iff it is non-empty, within length, and matches the traversal-proof charset. */
export function isValidHostedSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_HOSTED_SLUG_LEN && HOSTED_SLUG_RE.test(slug);
}

// --------------------------------------------------------------------------------------------------
// Feature flags — default-OFF, owner-workspace-first (mirrors #295 `resolveDeliveryFlags`).
// --------------------------------------------------------------------------------------------------

export interface HostedSitesFlags {
  /** Master: is hosted publishing usable for this workspace at all? */
  readonly enabled: boolean;
}

export const HOSTED_FLAGS_OFF: HostedSitesFlags = { enabled: false };

export interface HostedSitesConfigInput {
  enabled?: boolean;
  /** Restrict to the owner workspace until proven (default true). */
  ownerWorkspaceOnly?: boolean;
  ownerWorkspaceId?: string;
}

/**
 * Resolve the hosted-publishing flags for a workspace. DEFAULT OFF: unless `enabled === true` AND (the
 * workspace is the owner workspace OR `ownerWorkspaceOnly` was explicitly disabled), hosting is off. A
 * byte-for-byte copy of the #295 delivery resolver so the safety property is identical and obvious.
 */
export function resolveHostedSitesFlags(
  config: HostedSitesConfigInput | undefined,
  workspaceId: string,
): HostedSitesFlags {
  if (!config || config.enabled !== true) return HOSTED_FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  const inScope = ownerOnly
    ? config.ownerWorkspaceId !== undefined && config.ownerWorkspaceId === workspaceId
    : true;
  if (!inScope) return HOSTED_FLAGS_OFF;
  return { enabled: true };
}

// --------------------------------------------------------------------------------------------------
// Publish request validation — content is DATA.
// --------------------------------------------------------------------------------------------------

export interface HostedPublishRequest {
  kind?: string;
  title: string;
  body: string;
  /** Optional explicit slug; otherwise derived from `title`. */
  slug?: string;
  description?: string;
}

export interface HostedPublishPlan {
  ok: true;
  kind: HostedPageKind;
  slug: string;
  title: string;
  body: string;
  description: string;
}

export interface HostedPublishRejection {
  ok: false;
  reason: string;
}

/**
 * Validate a hosted publish request and derive its traversal-proof slug. Reads `title`/`body` ONLY for
 * emptiness and to slugify the title — never to choose a route/target (injection defense #200 §6). A
 * caller-supplied `slug` must already be a valid `[a-z0-9-]` slug (no silent re-slugify of attacker input
 * into a different page). Total + pure.
 */
export function decideHostedPublish(
  req: HostedPublishRequest,
): HostedPublishPlan | HostedPublishRejection {
  if (req.kind !== undefined && !isHostedPageKind(req.kind)) {
    return { ok: false, reason: `unknown page kind: ${String(req.kind)}` };
  }
  const kind: HostedPageKind = req.kind === undefined ? "article" : req.kind;

  const title = (req.title ?? "").trim();
  if (title.length === 0) return { ok: false, reason: "title is required" };
  if (title.length > MAX_HOSTED_TITLE_LEN) return { ok: false, reason: "title too long" };

  const body = (req.body ?? "").trim();
  if (body.length === 0) return { ok: false, reason: "body is required" };

  let slug: string;
  if (req.slug !== undefined && req.slug.trim().length > 0) {
    slug = req.slug.trim();
    if (!isValidHostedSlug(slug)) {
      return { ok: false, reason: "slug must match [a-z0-9-] and be ≤80 chars" };
    }
  } else {
    slug = slugifyHosted(title);
    if (!isValidHostedSlug(slug)) return { ok: false, reason: "title does not yield a usable slug" };
  }

  const description = (req.description ?? "").trim();
  return { ok: true, kind, slug, title, body, description };
}
