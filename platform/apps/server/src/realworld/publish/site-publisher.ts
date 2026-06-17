/**
 * The {@link SitePublisher} abstraction (#258). `publish_site` no longer talks to a concrete GitHub
 * provider — it talks to this interface, so two things slot in as first-class:
 *
 *   - {@link GitHubSitePublisher} — ipop.ai's OWN internal mechanism. Commits a content file + opens a PR
 *     against ipop's site repo, using a token resolved from the per-workspace ENCRYPTED connection (#192)
 *     rather than a Fly server secret. This is internal/admin only; a non-technical customer never sees
 *     a repo, a PR, or a token.
 *   - {@link IpopHostedSitePublisher} — the customer default to come: multi-tenant pages served on the
 *     customer's own domain via a one-time CNAME / ipop subdomain (zero repo, zero setup). Stubbed here
 *     so the interface is demonstrably first-class; the live impl + the "Connect your website" OAuth path
 *     ship in the follow-up.
 *
 * {@link resolveSitePublisher} picks the impl for a workspace from its connections + config. The money-only
 * gate (#243) and the #223 quarantine are unchanged: opening a PR / publishing a page stays money-free and
 * reversible, so it remains autonomous; the publisher has no send/spend seam.
 */

import type { IpopSitePublishResult } from "../service.js";
import type { PublishToIpopRequest } from "./site-pr-decide.js";
import { IpopSitePublishService, type ArtifactStore } from "../service.js";
import { GitHubSitePrProvider } from "./site-pr-provider.js";
import { createSitePrProvider } from "./site-pr-factory.js";
import { SITE_PUBLISH_GITHUB_ID } from "../../connections/registry.js";

/** What the caller asks to publish — provider-agnostic (a GitHub PR or a hosted page). */
export interface SitePublishRequest {
  workspaceId: string;
  ventureId?: string | null;
  title: string;
  content: string;
  slug?: string;
  /** PR/page description. */
  body?: string;
  extension?: string;
}

export type SitePublishResult =
  /** The workspace has no publishing connection yet (e.g. customer hasn't connected their website). */
  | { status: "not_connected"; reason: string }
  /** The request itself was invalid (empty/unslugglable) — rejected before any network call. */
  | { status: "rejected"; reason: string }
  /** Published. `url` is the canonical link (a PR url for GitHub, a page url for a hosted provider). */
  | {
      status: "published";
      kind: string;
      url: string;
      /** GitHub-specific extras (kept for the internal self-publish route's response shape). */
      prUrl?: string;
      branch?: string;
      path?: string;
      providerId?: string;
    }
  | { status: "failed"; error: string };

/** The publishing seam: one method, provider-agnostic. */
export interface SitePublisher {
  readonly kind: string;
  publish(req: SitePublishRequest): Promise<SitePublishResult>;
}

/** The inner GitHub publishing service surface (structural — {@link IpopSitePublishService} satisfies it). */
export interface SitePrPublishing {
  publish(input: {
    workspaceId: string;
    ventureId?: string | null;
    request: PublishToIpopRequest;
  }): Promise<IpopSitePublishResult>;
}

/** Internal/admin impl: ipop.ai's own GitHub-PR publishing, fed by a per-workspace connection token. */
export class GitHubSitePublisher implements SitePublisher {
  readonly kind = "github" as const;
  constructor(private readonly inner: SitePrPublishing) {}

  async publish(req: SitePublishRequest): Promise<SitePublishResult> {
    const r = await this.inner.publish({
      workspaceId: req.workspaceId,
      ventureId: req.ventureId ?? null,
      request: { title: req.title, content: req.content, slug: req.slug, body: req.body, extension: req.extension },
    });
    if (r.status === "rejected") return { status: "rejected", reason: r.reason };
    if (r.status === "failed") return { status: "failed", error: r.error };
    return {
      status: "published",
      kind: this.kind,
      url: r.prUrl,
      prUrl: r.prUrl,
      branch: r.branch,
      path: r.path,
      providerId: r.providerId,
    };
  }
}

/**
 * The customer-facing hosted publisher placeholder on the GitHub-PR-shaped {@link SitePublisher} seam.
 *
 * The REAL ipop-hosted publishing (#266, ADR-0266) — multi-tenant customer blogs + landing pages on the
 * customer's own domain, zero repo, zero deploy — ships as its OWN module (`src/hosted/`) and surface
 * (`/me/hosted/*`), because its flow does NOT fit this seam: a hosted page is DRAFTED, then PARKED behind a
 * #13 owner approval (nothing goes live without owner approval), then served — whereas this seam models
 * ipop.ai's autonomous internal GitHub-PR mechanism (it carries no requester/approval context). So this
 * publisher stays a not-connected placeholder here; customer hosting is reached through the hosted module,
 * which reuses the #13 queue + an injection-safe server renderer + the #264 DNS-verify seam.
 */
export class IpopHostedSitePublisher implements SitePublisher {
  readonly kind = "ipop_hosted" as const;
  async publish(_req: SitePublishRequest): Promise<SitePublishResult> {
    return {
      status: "not_connected",
      reason: "ipop-hosted publishing is served by the hosted module (/me/hosted) — see ADR-0266.",
    };
  }
}

/** The default when a workspace has no publishing connection at all. */
export class NotConnectedSitePublisher implements SitePublisher {
  readonly kind = "none" as const;
  async publish(_req: SitePublishRequest): Promise<SitePublishResult> {
    return { status: "not_connected", reason: "No publishing connection — connect a site to publish." };
  }
}

/** The slice of realworld config the resolver reads (back-compat env/static fallback). */
export interface SitePublisherConfig {
  sitePrProvider?: string;
  siteRepo?: string;
  siteBaseBranch?: string;
  siteContentDir?: string;
}

export interface ResolveSitePublisherDeps {
  /** Read a per-workspace connection's sealed secrets (e.g. `resolveServiceSecrets`). */
  readConnectionSecrets: (workspaceId: string, connectionId: string) => Promise<Record<string, string>>;
  config: SitePublisherConfig;
  /** Optional durable receipt sink for the inner GitHub service. */
  artifacts?: ArtifactStore;
}

/**
 * Pick the {@link SitePublisher} for a workspace. Resolution order for the internal self-publish path:
 *   1. The per-workspace internal GitHub connection (#192 vault) — token + repo from the ENCRYPTED
 *      credential, no env secret. This is the #258 goal.
 *   2. Back-compat: a config-driven GitHub provider with a legacy env token (pre-#258 deployments).
 *   3. Dry-run GitHub (the safe internal default — no network, exercisable end to end).
 *
 * The customer-facing resolution (ipop-hosted / "Connect your website") lands in the follow-up; this
 * resolver already returns through the same {@link SitePublisher} interface, so it slots in cleanly.
 */
export async function resolveSitePublisher(
  workspaceId: string,
  deps: ResolveSitePublisherDeps,
): Promise<SitePublisher> {
  const contentDir = deps.config.siteContentDir ?? "content/blog";

  // 1. Internal GitHub connection — the encrypted per-workspace credential.
  const conn = await deps.readConnectionSecrets(workspaceId, SITE_PUBLISH_GITHUB_ID);
  const token = conn.REALWORLD_GITHUB_TOKEN?.trim();
  const repo = conn.REALWORLD_SITE_REPO?.trim();
  if (token && repo) {
    const provider = new GitHubSitePrProvider({
      repo,
      baseBranch: conn.REALWORLD_SITE_BASE_BRANCH?.trim() || deps.config.siteBaseBranch,
      token,
    });
    return new GitHubSitePublisher(
      new IpopSitePublishService({ provider, contentDir, artifacts: deps.artifacts }),
    );
  }

  // 2. Back-compat: config-driven GitHub (legacy env token) — or 3. dry-run otherwise.
  const provider = await createSitePrProvider(deps.config.sitePrProvider ?? "dryrun", {
    repo: deps.config.siteRepo,
    baseBranch: deps.config.siteBaseBranch,
  });
  return new GitHubSitePublisher(
    new IpopSitePublishService({ provider, contentDir, artifacts: deps.artifacts }),
  );
}
