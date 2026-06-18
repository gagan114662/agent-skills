/**
 * Search Console auto-submit service (#265). Orchestrates the gated, externally-verified sitemap submission
 * + indexing loop. The safety properties are encoded in the SHAPE of this service, not by convention:
 *
 *  - `submitSitemap` is the agent/Scout/route entrypoint and has NO autonomous submit path. It can only
 *    ever PARK a PENDING #13 approval (premortem §4: a live submit to Google is pre-committed + human-gated,
 *    never agent-initiated). Even that only happens when the workspace's feature flag is ON (default OFF,
 *    owner-first) and the Google connection exists.
 *  - `executeApprovedSubmission` is the post-approval executor. It calls the provider (dry-run by default,
 *    so nothing hits Google), then VERIFIES against the real `sitemaps.get` response via the pure
 *    `decideSitemapVerification` (premortem §2: "submitted" only becomes "verified" when Search Console
 *    confirms it). Coverage flows through `decideCoverageReading`, which returns null rather than a
 *    fabricated count.
 *  - `summary` is the read model the scorecard / route reads — grounded only in recorded receipts.
 *
 * Every terminal outcome writes a durable receipt, so the founder console can only ever show what Search
 * Console actually confirmed.
 */
import type { FastifyBaseLogger } from "fastify";
import {
  decideCoverageReading,
  decideSitemapSubmission,
  decideSitemapVerification,
} from "./decide.js";
import { sanitizeField } from "./types.js";
import type { SitemapSubmissionPlan, SitemapVerification } from "./types.js";
import { searchConsoleAutoSubmitEnabledForWorkspace, type SearchConsoleCaps } from "./caps.js";
import type { SearchConsoleProvider } from "./provider.js";
import type {
  SearchConsoleSubmissionStore,
  SubmissionReceiptRow,
} from "../db/repositories/search-console.js";
import { MAX_DETAIL_LEN } from "./types.js";

/** The #13 approval seam (reuses the approvals queue; recorded-only until a human approves). */
export interface SearchConsoleApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface SearchConsoleDeps {
  store: SearchConsoleSubmissionStore;
  caps: (workspaceId: string) => SearchConsoleCaps;
  provider: (kind: SearchConsoleCaps["provider"]) => SearchConsoleProvider;
  /** The site whose sitemap we submit for this workspace (e.g. "https://ipop.ai"); "" when unknown. */
  siteUrl: (workspaceId: string) => string;
  /** True iff the workspace has a connected Google Search Console (the #260 `google` vault connection). */
  searchConsoleConnected: (workspaceId: string) => Promise<boolean>;
  approvals: SearchConsoleApprovalGate;
  now: () => Date;
  log?: FastifyBaseLogger;
}

export interface SubmitSitemapInput {
  workspaceId: string;
  requesterMemberId: string;
  /** Optional explicit sitemap URL (same-origin or rejected). Defaults to `${site}/sitemap.xml`. */
  sitemapUrl?: string;
  /** Optional new/changed URLs to request indexing for (foreign ones are dropped). */
  urls?: string[];
}

export type SubmitSitemapResult =
  | { status: "disabled"; reason: string }
  | { status: "not_connected"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "pending_approval"; approvalRequestId: string; plan: SitemapSubmissionPlan };

export interface ExecuteApprovedInput {
  workspaceId: string;
  approvalRequestId: string;
  plan: SitemapSubmissionPlan;
}

export interface ExecuteApprovedResult {
  status: "verified" | "submitted" | "failed";
  verification: SitemapVerification;
  indexingRequested: number;
  indexedPages: number | null;
}

export interface SearchConsoleSummary {
  /** True iff a VERIFIED submission receipt exists — the only thing that makes the tile "connected". */
  connected: boolean;
  autoSubmitEnabled: boolean;
  /** Indexed-page count from the latest verified receipt, or null (never fabricated). */
  indexedPages: number | null;
  latest: SubmissionReceiptRow | null;
}

export class SearchConsoleService {
  constructor(private readonly deps: SearchConsoleDeps) {}

  /**
   * The submit entrypoint. NO autonomous submit path: it returns `disabled` (flag off for this workspace),
   * `not_connected` (no Google Search Console connection), `rejected` (the request did not yield a valid
   * same-origin plan), or `pending_approval` (a #13 approval is parked, recorded-only until a human
   * approves). It NEVER submits anything live — only `executeApprovedSubmission` does.
   */
  async submitSitemap(input: SubmitSitemapInput): Promise<SubmitSitemapResult> {
    const caps = this.deps.caps(input.workspaceId);
    if (!searchConsoleAutoSubmitEnabledForWorkspace(caps, input.workspaceId)) {
      return {
        status: "disabled",
        reason: "auto-submit is disabled for this workspace (default OFF — owner enables it)",
      };
    }

    const siteUrl = this.deps.siteUrl(input.workspaceId);
    const planResult = decideSitemapSubmission({
      siteUrl,
      sitemapUrl: input.sitemapUrl,
      urls: input.urls,
    });
    if (!planResult.ok) {
      await this.record(input.workspaceId, {
        siteUrl: siteUrl || "",
        sitemapUrl: "",
        status: "rejected",
        approvalRequestId: null,
        provider: caps.provider,
        accepted: false,
        indexedPages: null,
        indexingRequested: 0,
        detail: planResult.reason,
      });
      return { status: "rejected", reason: planResult.reason };
    }
    const plan = planResult.plan;

    const connected = await this.deps.searchConsoleConnected(input.workspaceId);
    if (!connected) {
      await this.record(input.workspaceId, {
        siteUrl: plan.siteUrl,
        sitemapUrl: plan.sitemapUrl,
        status: "not_connected",
        approvalRequestId: null,
        provider: caps.provider,
        accepted: false,
        indexedPages: null,
        indexingRequested: 0,
        detail: "connect Google Search Console before Scout can submit the sitemap",
      });
      return {
        status: "not_connected",
        reason: "connect Google Search Console before Scout can submit the sitemap",
      };
    }

    // Structural always-gate: the ONLY thing this method can do is park a #13 approval (premortem §4).
    const approval = await this.deps.approvals.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      summary: `Submit sitemap ${plan.sitemapUrl} + request indexing for ${plan.indexingUrls.length} URL(s)`,
      payload: {
        source: "search_console",
        action: "submit_sitemap",
        siteUrl: plan.siteUrl,
        sitemapUrl: plan.sitemapUrl,
        urls: plan.indexingUrls,
      },
    });
    await this.record(input.workspaceId, {
      siteUrl: plan.siteUrl,
      sitemapUrl: plan.sitemapUrl,
      status: "pending_approval",
      approvalRequestId: approval.id,
      provider: caps.provider,
      accepted: false,
      indexedPages: null,
      indexingRequested: plan.indexingUrls.length,
      detail: `parked #13 approval ${approval.id}`,
    });
    return { status: "pending_approval", approvalRequestId: approval.id, plan };
  }

  /**
   * The post-approval executor — the ONLY path that touches the provider. With the default dry-run provider
   * nothing reaches Google: the submit "claim" is false, verification is not accepted, coverage is null, so
   * the receipt is honestly `submitted`/`failed` and the scorecard stays "not connected". Verification is
   * NEVER assumed — it is the real `sitemaps.get` response interpreted by the pure decide (premortem §2).
   */
  async executeApprovedSubmission(input: ExecuteApprovedInput): Promise<ExecuteApprovedResult> {
    const caps = this.deps.caps(input.workspaceId);
    const provider = this.deps.provider(caps.provider);
    const { plan } = input;

    const submit = await provider.submitSitemap({ siteUrl: plan.siteUrl, sitemapUrl: plan.sitemapUrl });

    let indexingRequested = 0;
    for (const url of plan.indexingUrls) {
      const receipt = await provider.requestIndexing({ siteUrl: plan.siteUrl, url });
      if (receipt?.requested) indexingRequested += 1;
    }

    // Verify against reality — never trust the submit's own claim (premortem §2).
    const rawStatus = await provider.getSitemap({ siteUrl: plan.siteUrl, sitemapUrl: plan.sitemapUrl });
    const verification = decideSitemapVerification(plan.sitemapUrl, rawStatus);

    const rawCoverage = await provider.coverage({ siteUrl: plan.siteUrl });
    const coverage = decideCoverageReading(rawCoverage, this.deps.now().getTime());
    const indexedPages = coverage?.indexedPages ?? null;

    const status: ExecuteApprovedResult["status"] = verification.accepted
      ? "verified"
      : submit.ok
        ? "submitted"
        : "failed";

    await this.record(input.workspaceId, {
      siteUrl: plan.siteUrl,
      sitemapUrl: plan.sitemapUrl,
      status,
      approvalRequestId: input.approvalRequestId,
      provider: caps.provider,
      accepted: verification.accepted,
      indexedPages,
      indexingRequested,
      detail: verification.accepted
        ? `verified by Search Console (${verification.submittedUrls} submitted, ${verification.indexedUrls} indexed)`
        : (submit.error ?? "submitted; awaiting Search Console confirmation"),
    });

    return { status, verification, indexingRequested, indexedPages };
  }

  /** The read model for the scorecard / route — connected only when a verified receipt exists. */
  async summary(workspaceId: string): Promise<SearchConsoleSummary> {
    const caps = this.deps.caps(workspaceId);
    const [latest, indexedPages] = await Promise.all([
      this.deps.store.latest(workspaceId),
      this.deps.store.latestVerifiedIndexedPages(workspaceId),
    ]);
    return {
      connected: indexedPages !== null,
      autoSubmitEnabled: searchConsoleAutoSubmitEnabledForWorkspace(caps, workspaceId),
      indexedPages,
      latest,
    };
  }

  private async record(
    workspaceId: string,
    input: Parameters<SearchConsoleSubmissionStore["record"]>[1],
  ): Promise<void> {
    await this.deps.store
      .record(workspaceId, { ...input, detail: sanitizeField(input.detail, MAX_DETAIL_LEN) })
      .catch((err) => {
        // A receipt hiccup must never throw out of an otherwise-correct gate decision.
        this.deps.log?.warn?.({ err }, "search-console: failed to record submission receipt");
      });
  }
}
