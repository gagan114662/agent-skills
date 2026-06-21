/**
 * Deliverable delivery — channel adapters (issue #295, ADR-0295).
 *
 * Each adapter turns a deliverable's drafted content into a real (or dry-run) ship through an EXISTING
 * provider seam — no new actuator is invented:
 *
 *  - {@link PublishChannelAdapter} reuses the #231 {@link PublishProvider}: it wraps the draft into a
 *    standalone HTML page and publishes it to a live, reachable URL, then HEAD-checks the URL to PROVE it
 *    is live (premortem #200 §3). With the dry-run provider (the default) the page is not reachable and
 *    `live:false`; with `github_pages` connected it is a genuine live URL.
 *  - {@link SocialChannelAdapter} / {@link EmailChannelAdapter} reuse the #189 acquisition providers. These
 *    default to DRY-RUN (no network egress, `live:false`): a real X/LinkedIn or ESP adapter is a deliberate
 *    future step behind connected credentials (out of scope for #295 — "no credentials"). Email ships with
 *    NO recipients (a content draft carries none), so it can never reach a real inbox here.
 *
 * The draft is opaque DATA: the publish adapter HTML-escapes it so injected markup in the draft renders as
 * inert text, never executable content on the published page.
 */

import { ActionExecutionError } from "../approvals/executor.js";
import type { PublishProvider } from "../realworld/publish/provider.js";
import type { SitePublisher } from "../realworld/publish/site-publisher.js";
import type { EspProvider, SocialProvider } from "../acquisition/providers.js";
import { appendBadge } from "../attribution/badge.js";
import type { BadgeFormat } from "../attribution/badge.js";
import type { ChannelAdapter, ChannelShipInput, ChannelShipOutcome } from "./dispatcher.js";

/**
 * The "Built with ipop" badge seam (#399, ADR-0399). An adapter asks for the badge snippet to append to the
 * artifact it is about to ship; the IMPLEMENTATION gates on the attribution flag (default-OFF, owner-first)
 * so a workspace without attribution active gets `null` and the artifact is byte-for-byte unchanged. Keeping
 * the gate behind this seam (resolved in the production wiring) keeps the adapters + `draftToHtml` pure.
 */
export type AttributionBadgeFor = (input: {
  workspaceId: string;
  /** The artifact a click is attributed back to (content path / page slug / PR title). */
  artifactId: string;
  format: BadgeFormat;
}) => string | null;

/** A DNS/URL-safe slug derived from the task (or a fallback), bounded so it is always a valid repo/path part. */
export function slugify(task: string, fallback = "deliverable"): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

/**
 * Wrap a raw fleet draft in the blog frontmatter the prerendered blog requires (#252). Without a `--- … ---`
 * block carrying `status: published`, `posts.ts` treats the file as an invisible non-post — so an
 * autonomously-shipped deliverable (a plain markdown body) would never render on /blog. We synthesize a
 * valid header (title / slug / description / date / `status: published`) so the fleet's content actually
 * goes live. If the agent already produced its own frontmatter we respect it untouched. Values are
 * single-line + quoted (the blog's tiny parser reads `key: "value"`); the body is the draft verbatim.
 */
export function ensureBlogFrontmatter(draft: string, title: string, now: Date): string {
  const body = draft.replace(/^\uFEFF/, "").replace(/^\s+/, "");
  if (body.startsWith("---")) return draft; // the agent supplied its own frontmatter — leave it alone
  const yaml = (s: string): string => `"${s.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim()}"`;
  const excerpt = body
    .replace(/^#+\s*/gm, "")
    .replace(/[*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const header = [
    "---",
    `title: ${yaml(title)}`,
    `slug: ${slugify(title)}`,
    `description: ${yaml(excerpt || title)}`,
    `date: ${now.toISOString().slice(0, 10)}`,
    "status: published",
    "---",
    "",
    "",
  ].join("\n");
  return header + body;
}

/** Escape the five HTML-significant characters so a draft renders as inert text, never executable markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a (untrusted) draft into a minimal, standalone HTML document with the draft escaped as text. */
export function draftToHtml(title: string, draft: string): string {
  const safeTitle = escapeHtml(title || "Deliverable");
  const safeBody = escapeHtml(draft).replace(/\n/g, "<br>\n");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${safeTitle}</title></head><body><main><h1>${safeTitle}</h1>` +
    `<article>${safeBody}</article></main></body></html>`
  );
}

/** Publish a deliverable to a live, reachable URL via the #231 publish provider, proving it with a HEAD check. */
export class PublishChannelAdapter implements ChannelAdapter {
  readonly channel = "publish" as const;
  readonly providerKind: string;
  constructor(
    private readonly provider: PublishProvider,
    /** Optional #399 badge seam — gated; undefined / null ⇒ no badge, page unchanged. */
    private readonly badgeFor?: AttributionBadgeFor,
  ) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const slug = slugify(input.task);
    // #399: when attribution is active, append a tracked "Built with ipop" footer before </body>. The gate
    // lives behind badgeFor — inactive ⇒ null ⇒ the published HTML is byte-for-byte unchanged.
    const badge = this.badgeFor?.({ workspaceId: input.workspaceId, artifactId: slug, format: "html" });
    const html = badge
      ? appendBadge(draftToHtml(input.task, input.draft), badge, "html")
      : draftToHtml(input.task, input.draft);
    const outcome = await this.provider.publish({
      workspaceId: input.workspaceId,
      slug,
      html,
      onLog: () => undefined,
    });
    if (outcome.status !== "ready" || !outcome.url) {
      throw new ActionExecutionError(outcome.error ?? "publish failed");
    }
    // Production-grounded verification (#200 §3): the URL is only "live" if it actually answers.
    const health = await this.provider.healthCheck(outcome.url);
    return {
      provider: this.provider.kind,
      live: health.ok,
      externalRef: outcome.url,
      detail: { slug, providerId: outcome.providerId ?? null, healthStatus: health.status },
    };
  }
}

/** A reachability check (HEAD/GET) used to PROVE the opened PR url answers — injected only for a live provider. */
export type SitePrHeadCheck = (url: string) => Promise<{ ok: boolean; status: number }>;

/**
 * Ship an approved content/SEO deliverable as a REAL on-site change to ipop's OWN site repo — a pull
 * request — through the existing {@link SitePublisher} seam (#250/#364). This is the single lowest-risk
 * real marketing action: a PR is a REVIEW surface (it changes nothing on the live site; merge/deploy stays
 * a human action on GitHub), it is reversible (close/revert), money-free, and authenticated by ipop's own
 * server token (no third-party OAuth, no per-customer credential).
 *
 * The deliverable's draft is opaque DATA: it is committed verbatim as a content FILE; the file's slug/path
 * and branch are derived STRUCTURALLY from the task title by `decidePublishToIpop` (traversal-proof,
 * `[a-z0-9-]` only) — injected instructions in the draft can never escape the content dir, retarget the
 * repo, or redirect the ship (#200 §6).
 *
 * Production-grounded verification (#200 §3): `live` is true ONLY when an injected {@link SitePrHeadCheck}
 * confirms the PR url answers 2xx. The readback is injected ONLY when a live provider is configured; the
 * default dry-run path passes no readback (no network egress) and is honestly recorded `live:false`.
 */
export class SitePrChannelAdapter implements ChannelAdapter {
  readonly channel = "site_pr" as const;
  readonly providerKind: string;
  constructor(
    private readonly publisher: SitePublisher,
    private readonly headCheck?: SitePrHeadCheck,
    /** Optional #399 badge seam — gated; undefined / null ⇒ no badge, content unchanged. */
    private readonly badgeFor?: AttributionBadgeFor,
  ) {
    this.providerKind = publisher.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    // GitHub rejects a PR title over 256 chars with a 422 — and the task is often a full multi-sentence
    // brief (a content-cadence goal), which silently failed the autonomous ship. Keep a concise,
    // whitespace-collapsed title well under the limit; the publisher derives the slug/path from this too.
    const rawTitle = (input.task || "ipop on-site content").replace(/\s+/g, " ").trim();
    const title = (rawTitle.length <= 120 ? rawTitle : rawTitle.slice(0, 120).trim()) || "ipop on-site content";
    // #399: when attribution is active, append a tracked "Built with ipop" footer to the committed file. The
    // publisher slugs the title into a `.md` content path, so the badge is markdown. The gate lives behind
    // badgeFor — inactive ⇒ null ⇒ the committed content is byte-for-byte unchanged.
    const badge = this.badgeFor?.({ workspaceId: input.workspaceId, artifactId: title, format: "markdown" });
    // Make the raw draft a real, VISIBLE blog post (#252 requires `status: published` frontmatter) so the
    // autonomous ship actually goes live on /blog instead of committing an invisible non-post.
    const post = ensureBlogFrontmatter(input.draft, title, new Date());
    const content = badge ? appendBadge(post, badge, "markdown") : post;
    const result = await this.publisher.publish({
      workspaceId: input.workspaceId,
      title,
      // The draft is the file body — opaque DATA. The slug/path/branch are derived from the title only.
      content,
      body: "On-site content drafted by the ipop fleet, approved by the owner at the #13 gate (#364).",
    });
    if (result.status !== "published") {
      const reason =
        result.status === "not_connected" || result.status === "rejected"
          ? result.reason
          : result.error;
      throw new ActionExecutionError(`site PR not opened (${result.status}): ${reason}`);
    }
    // Only an answering PR url is "live". Dry-run (no headCheck) never claims a live PR.
    const health = this.headCheck
      ? await this.headCheck(result.url)
      : { ok: false, status: 0 };
    return {
      provider: this.publisher.kind,
      live: health.ok,
      externalRef: result.url,
      detail: {
        prUrl: result.prUrl ?? result.url,
        branch: result.branch ?? null,
        path: result.path ?? null,
        providerId: result.providerId ?? null,
        headStatus: health.status,
      },
    };
  }
}

/** Post a deliverable to social via the #189 social provider (dry-run by default — no real network). */
export class SocialChannelAdapter implements ChannelAdapter {
  readonly channel = "social" as const;
  readonly providerKind: string;
  constructor(private readonly provider: SocialProvider) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const outcome = await this.provider.publish({
      workspaceId: input.workspaceId,
      ideaId: null,
      // The network is a constant default (NOT parsed from the draft) — injection cannot retarget it.
      network: "social",
      text: input.draft,
    });
    if (outcome.status !== "sent") {
      throw new ActionExecutionError(`social post failed via ${outcome.provider}`);
    }
    return {
      provider: outcome.provider,
      // Only a non-dry-run provider is a genuine live post.
      live: outcome.provider !== "dryrun",
      externalRef: outcome.externalId,
      detail: { ...outcome.detail },
    };
  }
}

/** Send a deliverable via the #189 ESP (dry-run by default; NO recipients — a content draft carries none). */
export class EmailChannelAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  readonly providerKind: string;
  constructor(private readonly provider: EspProvider) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const outcome = await this.provider.send({
      workspaceId: input.workspaceId,
      ideaId: null,
      subject: input.task || "Deliverable",
      body: input.draft,
      // A content draft carries no recipient list; we NEVER invent real addresses (#295 hard constraint).
      recipients: [],
    });
    if (outcome.status !== "sent") {
      throw new ActionExecutionError(`email send failed via ${outcome.provider}`);
    }
    return {
      // No recipients + dry-run ⇒ nothing reached a real inbox; never claim a live send here.
      provider: outcome.provider,
      live: false,
      externalRef: outcome.externalId,
      detail: { ...outcome.detail, recipientCount: 0 },
    };
  }
}
