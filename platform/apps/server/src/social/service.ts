/**
 * #269 — the social-posting service: the orchestration that turns Echo's drafted post into a real fan-out
 * across every connected network through the connect-once aggregator bridge, while honoring the HARD
 * constraint that NOTHING is posted without an explicit owner approval (a post is IRREVERSIBLE — premortem
 * #200 §4 — so the always-gate is the required pre-commitment, regardless of the money-only #243 default).
 *
 * The lifecycle, and where each safety invariant binds:
 *   1. `draftPost`    — validate (body is DATA, #200 §6), store as `draft`. Autonomous — a draft posts nothing.
 *   2. `previewPost`  — the per-network preview (pure). No store, no network.
 *   3. `requestPublish` — ALWAYS parks a #13 approval and flips the post to `pending_approval` (the hard
 *                       constraint — never auto-posts). Gated default-OFF, owner-workspace-first.
 *   4. `executePublish` — runs ONLY from the post-approval path ({@link SocialPublishDispatcher}), fail-closed
 *                       on a missing approval id. Fans out via the aggregator, then READS BACK each network's
 *                       permalink (#200 §3) and records the externally-grounded receipts. Never claims a live
 *                       post for a dry-run provider.
 *   5. `summary`      — published-post counts come ONLY from recorded receipts (#200 §2: external receipt,
 *                       never self-report).
 */

import {
  buildNetworkPreviews,
  decideSocialPost,
  mapFanOutToReceipts,
  resolveSocialFlags,
  summarizePostStatus,
  type NetworkPreview,
  type SocialConfigInput,
  type SocialFlags,
} from "./decide.js";
import type { SocialAggregatorProvider, SocialNetworkReceipt } from "./aggregator.js";
import type {
  RecordSocialResultInput,
  SocialPostRecord,
  SocialPostResultRecord,
  SocialPostStore,
  SocialResultStore,
} from "./store.js";

/**
 * The #13 gate seam — submit (only). The hard constraint means publishing ALWAYS parks; there is no
 * "requiresApproval" branch (unlike the money-only realworld gate). Mirrors {@link HostedApprovalGate}.
 */
export interface SocialApprovalGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface SocialPublishDeps {
  posts: SocialPostStore;
  results: SocialResultStore;
  /** The connect-once aggregator bridge (dry-run by default — posts nothing real). */
  aggregator: SocialAggregatorProvider;
  approvals: SocialApprovalGate;
  /** Resolved feature flags for a workspace (config → {@link resolveSocialFlags}). */
  flags: (workspaceId: string) => SocialFlags;
  /** Injected clock so schedule validation + timestamps are deterministic in tests. */
  now?: () => Date;
}

export interface DraftPostInput {
  workspaceId: string;
  body: string;
  networks: string[];
  scheduledAt?: string | null;
}

export type DraftPostResult =
  | { status: "disabled" }
  | { status: "rejected"; reason: string }
  | { status: "drafted"; post: SocialPostRecord; previews: NetworkPreview[] };

export type PreviewPostResult =
  | { status: "disabled" }
  | { status: "rejected"; reason: string }
  | { status: "ok"; previews: NetworkPreview[] };

export type RequestPublishResult =
  | { status: "disabled" }
  | { status: "not_found" }
  | { status: "rejected"; reason: string }
  | { status: "pending_approval"; approvalRequestId: string; postId: string };

export type PublishOutcome =
  | { status: "failed"; error: string }
  | {
      status: "published" | "partially_published" | "scheduled";
      /** True ONLY when a live provider actually posted (false for the dry-run default). */
      live: boolean;
      postId: string;
      aggregatorRef: string | null;
      receipts: SocialNetworkReceipt[];
    };

export interface SocialSummary {
  enabled: boolean;
  /** Whether a LIVE aggregator is wired (false ⇒ dry-run, nothing posts for real). */
  providerLive: boolean;
  providerKind: string;
  totalPosts: number;
  publishedPosts: number;
  /** Externally-verified per-network published receipts. */
  publishedReceipts: number;
}

export class SocialPublishService {
  private readonly now: () => Date;

  constructor(private readonly deps: SocialPublishDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Validate + store a DRAFT post. The draft posts nothing — it is invisible until an owner approves. */
  async draftPost(input: DraftPostInput): Promise<DraftPostResult> {
    if (!this.deps.flags(input.workspaceId).enabled) return { status: "disabled" };
    const plan = decideSocialPost(
      { body: input.body, networks: input.networks, scheduledAt: input.scheduledAt ?? null },
      { now: this.now() },
    );
    if (!plan.ok) return { status: "rejected", reason: plan.reason };

    const post = await this.deps.posts.createDraft({
      workspaceId: input.workspaceId,
      body: plan.body,
      networks: plan.networks,
      scheduledAt: plan.scheduledAt,
    });
    return { status: "drafted", post, previews: buildNetworkPreviews(plan.body, plan.networks) };
  }

  /** The per-network preview for a candidate post — pure, no store, no network. */
  previewPost(input: DraftPostInput): PreviewPostResult {
    if (!this.deps.flags(input.workspaceId).enabled) return { status: "disabled" };
    const plan = decideSocialPost(
      { body: input.body, networks: input.networks, scheduledAt: input.scheduledAt ?? null },
      { now: this.now() },
    );
    if (!plan.ok) return { status: "rejected", reason: plan.reason };
    return { status: "ok", previews: buildNetworkPreviews(plan.body, plan.networks) };
  }

  /**
   * Park a #13 approval for a drafted post. ALWAYS queues (the hard constraint) — there is no autonomous
   * publish path. Routing is structural: the approval payload carries only the post id + the network LIST +
   * a schedule marker, never the body (a poisoned draft can never redirect the fan-out — #200 §6).
   */
  async requestPublish(input: {
    workspaceId: string;
    postId: string;
    requesterMemberId: string;
  }): Promise<RequestPublishResult> {
    if (!this.deps.flags(input.workspaceId).enabled) return { status: "disabled" };
    const post = await this.deps.posts.getById(input.postId);
    if (!post || post.workspaceId !== input.workspaceId) return { status: "not_found" };
    if (post.status === "published" || post.status === "partially_published") {
      return { status: "rejected", reason: "post has already been published" };
    }
    const when = post.scheduledAt ? `scheduled for ${post.scheduledAt}` : "immediately";
    const approval = await this.deps.approvals.submit({
      workspaceId: input.workspaceId,
      requesterMemberId: input.requesterMemberId,
      summary: `Publish a social post to ${post.networks.join(", ")} (${when})`.slice(0, 140),
      payload: {
        source: "social",
        postId: post.id,
        networks: post.networks,
        scheduledAt: post.scheduledAt,
      },
    });
    await this.deps.posts.applyStatus(post.id, {
      status: "pending_approval",
      approvalRequestId: approval.id,
    });
    return { status: "pending_approval", approvalRequestId: approval.id, postId: post.id };
  }

  /**
   * Fan a post OUT to every target network. Runs ONLY from the post-approval dispatcher: fail-closed on a
   * missing approval id (the structural proof nothing posts without an approval). After the fan-out it READS
   * BACK each network's status + permalink from the aggregator (#200 §3) and records the externally-grounded
   * receipts; the overall status is derived ONLY from those verified receipts. `live` is the provider's own
   * truth — false for the dry-run default, so this can never claim a real post that did not happen.
   */
  async executePublish(input: {
    workspaceId: string;
    postId: string;
    approvalRequestId: string;
  }): Promise<PublishOutcome> {
    if (!input.approvalRequestId) {
      return { status: "failed", error: "missing approval id — refusing to publish" };
    }
    const post = await this.deps.posts.getById(input.postId);
    if (!post || post.workspaceId !== input.workspaceId) {
      return { status: "failed", error: "post not found in workspace" };
    }

    const fanOut = await this.deps.aggregator.publish({
      workspaceId: input.workspaceId,
      body: post.body,
      networks: post.networks,
      scheduledAt: post.scheduledAt,
    });

    // Verified receipts: start from the (premortem-screened) fan-out receipts, then enrich each with the
    // permalink read back from the aggregator's real API (#200 §3) when the ref resolves to a live post.
    let receipts = mapFanOutToReceipts(fanOut.receipts);
    if (fanOut.aggregatorRef) {
      const verified = await this.deps.aggregator.verify({
        workspaceId: input.workspaceId,
        aggregatorRef: fanOut.aggregatorRef,
      });
      receipts = enrichWithPermalinks(receipts, verified.receipts);
    }

    const overall = summarizePostStatus(receipts);
    await this.recordResults(input.workspaceId, post.id, receipts);
    await this.deps.posts.applyStatus(post.id, {
      status: overall,
      aggregatorRef: fanOut.aggregatorRef,
    });

    if (overall === "failed") {
      return { status: "failed", error: "no network accepted the post" };
    }
    return {
      status: overall,
      live: this.deps.aggregator.live,
      postId: post.id,
      aggregatorRef: fanOut.aggregatorRef,
      receipts,
    };
  }

  /** The workspace's posts (drafts + published), most-recent first. */
  async listPosts(workspaceId: string, limit = 50): Promise<SocialPostRecord[]> {
    return this.deps.posts.listByWorkspace(workspaceId, limit);
  }

  /** The recorded per-network receipts for a post (the external-receipt proof). */
  async resultsForPost(postId: string): Promise<SocialPostResultRecord[]> {
    return this.deps.results.listForPost(postId);
  }

  /** Externally-grounded metrics for the console: real recorded published-receipt counts only. */
  async summary(workspaceId: string): Promise<SocialSummary> {
    const enabled = this.deps.flags(workspaceId).enabled;
    const posts = await this.deps.posts.listByWorkspace(workspaceId);
    const published = posts.filter(
      (p) => p.status === "published" || p.status === "partially_published",
    ).length;
    const publishedReceipts = await this.deps.results.countPublishedForWorkspace(workspaceId);
    return {
      enabled,
      providerLive: this.deps.aggregator.live,
      providerKind: this.deps.aggregator.kind,
      totalPosts: posts.length,
      publishedPosts: published,
      publishedReceipts,
    };
  }

  private async recordResults(
    workspaceId: string,
    postId: string,
    receipts: readonly SocialNetworkReceipt[],
  ): Promise<void> {
    const rows: RecordSocialResultInput[] = receipts.map((r) => ({
      workspaceId,
      postId,
      network: r.network,
      status: r.status,
      externalId: r.externalId,
      permalink: r.permalink,
      error: r.error,
    }));
    await this.deps.results.record(postId, rows);
  }
}

/**
 * Enrich each published receipt with the permalink read back from {@link SocialAggregatorProvider.verify},
 * matched by network. A receipt the read-back does not cover keeps its original (null) permalink. Pure.
 */
function enrichWithPermalinks(
  base: readonly SocialNetworkReceipt[],
  verified: readonly SocialNetworkReceipt[],
): SocialNetworkReceipt[] {
  const byNetwork = new Map(verified.map((v) => [v.network, v]));
  return base.map((r) => {
    if (r.status !== "published") return r;
    const v = byNetwork.get(r.network);
    if (!v) return r;
    return { ...r, permalink: v.permalink ?? r.permalink, externalId: r.externalId ?? v.externalId };
  });
}

/** Resolve flags from a config block (the production `flags` dep). */
export function socialFlagsFromConfig(
  config: SocialConfigInput | undefined,
  workspaceId: string,
): SocialFlags {
  return resolveSocialFlags(config, workspaceId);
}
