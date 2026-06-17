/**
 * #266 — the hosted-publishing service: the orchestration that turns a customer's content into a live page
 * on their own domain with ZERO repo and ZERO deploy, while honouring the HARD constraint that NOTHING goes
 * live without an explicit owner approval.
 *
 * The lifecycle, and where each safety invariant binds:
 *   1. `ensureSite`   — get/create the workspace's site (a free ipop subdomain). Money-free, autonomous.
 *   2. `draftPage`    — validate (content is DATA, #200 §6), render an injection-safe document, store as
 *                       `draft`. Autonomous — a draft is invisible.
 *   3. `requestPublish` — ALWAYS parks a #13 approval and flips the page to `pending_approval` (the hard
 *                       constraint — never auto-publishes, regardless of the money-only #243 default). Gated
 *                       default-OFF, owner-workspace-first.
 *   4. `executePublish` — runs ONLY from the post-approval path ({@link HostedPublishDispatcher}), fail-closed
 *                       on a missing approval id. Re-renders bound to the canonical URL, flips to `published`.
 *   5. `unpublish`    — the reversible take-down (#200 §4): a published page can always be pulled.
 *   6. `serve`        — resolves a public request to a `published` page's bytes and records a real view
 *                       receipt. `summary` reports published-page + view counts ONLY from recorded rows
 *                       (#200 §2: a metric rests on an external receipt, never self-report).
 */

import {
  decideHostedPublish,
  resolveHostedSitesFlags,
  type HostedSitesConfigInput,
  type HostedSitesFlags,
} from "./decide.js";
import { resolveHostedHost, resolveHostedUrl, IPOP_HOSTED_BASE_HOST } from "./domain.js";
import { renderHostedPage } from "./render.js";
import type {
  HostedPageRecord,
  HostedPageStore,
  HostedSiteRecord,
  HostedSiteStore,
  HostedViewStore,
} from "./store.js";

/** The #13 gate seam — submit (only). The hard constraint means publishing ALWAYS parks; there is no
 * "requiresApproval" branch (unlike the money-only realworld gate). */
export interface HostedApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface HostedPublishDeps {
  sites: HostedSiteStore;
  pages: HostedPageStore;
  views: HostedViewStore;
  approvals: HostedApprovalGate;
  /** Resolved feature flags for a workspace (config → {@link resolveHostedSitesFlags}). */
  flags: (workspaceId: string) => HostedSitesFlags;
  /** ipop subdomain base host (config-overridable). */
  baseHost?: string;
  /** Injected clock so publish timestamps are deterministic in tests. */
  now?: () => Date;
}

export interface DraftPageInput {
  workspaceId: string;
  kind?: string;
  title: string;
  body: string;
  slug?: string;
  description?: string;
}

export type DraftPageResult =
  | { status: "disabled" }
  | { status: "rejected"; reason: string }
  | { status: "drafted"; page: HostedPageRecord };

export type RequestPublishResult =
  | { status: "disabled" }
  | { status: "not_found" }
  | { status: "rejected"; reason: string }
  | { status: "pending_approval"; approvalRequestId: string; pageId: string };

export type PublishOutcome =
  | { status: "published"; url: string; pageId: string }
  | { status: "failed"; error: string };

export type ServeResult = { html: string; pageId: string } | null;

export interface HostedSummary {
  enabled: boolean;
  siteHost: string | null;
  publishedPages: number;
  totalViews: number;
}

export class HostedPublishService {
  private readonly baseHost: string;
  private readonly now: () => Date;

  constructor(private readonly deps: HostedPublishDeps) {
    this.baseHost = deps.baseHost ?? IPOP_HOSTED_BASE_HOST;
    this.now = deps.now ?? (() => new Date());
  }

  /** Get the workspace's site, creating a free-subdomain site on first use. Money-free + autonomous. */
  async ensureSite(workspaceId: string, opts: { subdomain?: string; name?: string } = {}): Promise<HostedSiteRecord> {
    const existing = await this.deps.sites.firstForWorkspace(workspaceId);
    if (existing) return existing;
    const subdomain = (opts.subdomain ?? workspaceId).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "site";
    return this.deps.sites.create({ workspaceId, subdomain, name: opts.name ?? "" });
  }

  /** Validate + render + store a DRAFT page. The draft is invisible until an owner approves a publish. */
  async draftPage(input: DraftPageInput): Promise<DraftPageResult> {
    if (!this.deps.flags(input.workspaceId).enabled) return { status: "disabled" };
    const plan = decideHostedPublish({
      kind: input.kind,
      title: input.title,
      body: input.body,
      slug: input.slug,
      description: input.description,
    });
    if (!plan.ok) return { status: "rejected", reason: plan.reason };

    const site = await this.ensureSite(input.workspaceId);
    const url = resolveHostedUrl(site, plan.slug, { baseHost: this.baseHost });
    const html = renderHostedPage({
      page: { kind: plan.kind, title: plan.title, body: plan.body, slug: plan.slug, description: plan.description },
      site: { name: site.name },
      url,
    });
    const page = await this.deps.pages.upsertDraft({
      workspaceId: input.workspaceId,
      siteId: site.id,
      kind: plan.kind,
      slug: plan.slug,
      title: plan.title,
      body: plan.body,
      description: plan.description,
      html,
    });
    return { status: "drafted", page };
  }

  /**
   * Park a #13 approval for a drafted page. ALWAYS queues (the hard constraint) — there is no autonomous
   * publish path. Routing is structural: the approval payload carries only the page id + slug, never the
   * content (a poisoned draft can never redirect the publish — #200 §6).
   */
  async requestPublish(input: {
    workspaceId: string;
    pageId: string;
    requesterMemberId: string;
  }): Promise<RequestPublishResult> {
    if (!this.deps.flags(input.workspaceId).enabled) return { status: "disabled" };
    const page = await this.deps.pages.getById(input.pageId);
    if (!page || page.workspaceId !== input.workspaceId) return { status: "not_found" };
    if (page.status === "published") {
      return { status: "rejected", reason: "page is already published" };
    }
    const approval = await this.deps.approvals.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      summary: `Publish "${page.title}" to the live customer site (/${page.slug})`,
      payload: { source: "hosted", pageId: page.id, slug: page.slug, siteId: page.siteId },
    });
    await this.deps.pages.applyStatus(page.id, {
      status: "pending_approval",
      approvalRequestId: approval.id,
    });
    return { status: "pending_approval", approvalRequestId: approval.id, pageId: page.id };
  }

  /**
   * Take a page LIVE. Runs ONLY from the post-approval dispatcher path: fail-closed on a missing approval id
   * (the structural proof nothing ships without an approval — #295 invariant). Re-renders the page bound to
   * its canonical URL and flips it to `published`.
   */
  async executePublish(input: {
    workspaceId: string;
    pageId: string;
    approvalRequestId: string;
  }): Promise<PublishOutcome> {
    if (!input.approvalRequestId) return { status: "failed", error: "missing approval id — refusing to publish" };
    const page = await this.deps.pages.getById(input.pageId);
    if (!page || page.workspaceId !== input.workspaceId) {
      return { status: "failed", error: "page not found in workspace" };
    }
    const site = await this.deps.sites.getById(page.siteId);
    if (!site) return { status: "failed", error: "site not found" };

    const url = resolveHostedUrl(site, page.slug, { baseHost: this.baseHost });
    const publishedAt = this.now().toISOString();
    const html = renderHostedPage({
      page: {
        kind: page.kind,
        title: page.title,
        body: page.body,
        slug: page.slug,
        description: page.description,
        publishedAt,
      },
      site: { name: site.name },
      url,
    });
    await this.deps.pages.applyStatus(page.id, {
      status: "published",
      html,
      publicUrl: url,
      approvalRequestId: input.approvalRequestId,
      publishedAt,
    });
    return { status: "published", url, pageId: page.id };
  }

  /** The reversible take-down (#200 §4): pull a published page. Idempotent. */
  async unpublish(input: { workspaceId: string; pageId: string }): Promise<{ status: "unpublished" | "not_found" }> {
    const page = await this.deps.pages.getById(input.pageId);
    if (!page || page.workspaceId !== input.workspaceId) return { status: "not_found" };
    await this.deps.pages.applyStatus(page.id, { status: "unpublished", publicUrl: null });
    return { status: "unpublished" };
  }

  /**
   * Resolve a public request `(host, slug)` to a published page's bytes and record a real view receipt. The
   * host is matched structurally (verified custom domain, else the ipop subdomain); only a `published` page
   * is served. Returns null (→ 404) otherwise.
   */
  async serve(host: string, slug: string, opts: { referrer?: string | null } = {}): Promise<ServeResult> {
    const site = await this.resolveSiteByHost(host);
    if (!site) return null;
    const page = await this.deps.pages.getBySiteSlug(site.id, slug);
    if (!page || page.status !== "published" || !page.html) return null;
    await this.deps.views.record({ workspaceId: page.workspaceId, pageId: page.id, referrer: opts.referrer ?? null });
    return { html: page.html, pageId: page.id };
  }

  /** The workspace's pages (drafts + published), most-recently-updated first. */
  async listPages(workspaceId: string, limit = 50): Promise<HostedPageRecord[]> {
    return this.deps.pages.listByWorkspace(workspaceId, limit);
  }

  /** Externally-grounded metrics for the console: real published-page + recorded-view counts only. */
  async summary(workspaceId: string): Promise<HostedSummary> {
    const enabled = this.deps.flags(workspaceId).enabled;
    const site = await this.deps.sites.firstForWorkspace(workspaceId);
    const pages = await this.deps.pages.listByWorkspace(workspaceId);
    const published = pages.filter((p) => p.status === "published").length;
    const views = await this.deps.views.countForWorkspace(workspaceId);
    return {
      enabled,
      siteHost: site ? resolveHostedHost(site, { baseHost: this.baseHost }) : null,
      publishedPages: published,
      totalViews: views,
    };
  }

  private async resolveSiteByHost(host: string): Promise<HostedSiteRecord | null> {
    const h = host.trim().toLowerCase();
    const suffix = `.${this.baseHost}`;
    if (h.endsWith(suffix)) {
      const subdomain = h.slice(0, -suffix.length);
      return subdomain ? this.deps.sites.getBySubdomain(subdomain) : null;
    }
    const site = await this.deps.sites.getByCustomDomain(h);
    // Only serve a custom domain once #264 verified control of it.
    return site && site.domainVerified ? site : null;
  }
}

/** Resolve flags from a config block (the production `flags` dep). */
export function hostedFlagsFromConfig(
  config: HostedSitesConfigInput | undefined,
  workspaceId: string,
): HostedSitesFlags {
  return resolveHostedSitesFlags(config, workspaceId);
}
