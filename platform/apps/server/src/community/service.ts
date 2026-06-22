/**
 * The community participation service (issue #597) — the agent every distribution worker calls. It owns the
 * contract that keeps community participation safe and non-spammy:
 *
 *   1. discover(workspaceId, input)          → find relevant threads, draft a value-first reply for each, and run
 *                                               the anti-spam gate. Returns candidates with their gate decision.
 *                                               NOTHING is persisted or posted; this is a read-only dry run.
 *   2. queue(workspaceId, input)             → re-runs the gate and persists a `queued` record ONLY if it passes.
 *                                               A blocked (spammy) reply is REFUSED here — it never even queues.
 *                                               NOTHING posts; this is the swipe-approve item.
 *   3. post(workspaceId, id, {approval})     → the approved action. Requires an approval id (the #13 swipe-approve
 *                                               flow), then calls the platform provider once and records the
 *                                               external id. Never auto-posts.
 *
 * The guardrails are structural, not advisory:
 *   - `queue` is fail-closed on the gate → a reply that fails any anti-spam rule can never become a queued item.
 *   - `post` refuses without an `approvalRequestId` → a reply can never ship "auto", only from an approved item.
 *   - With the master switch OFF every method is an inert no-op (no provider is ever touched), so the default
 *     deployment cannot fetch or post.
 *   - The production provider registry is the deterministic sandbox (`provider.ts`), so even enabled + approved
 *     does not live-post until a real transport is wired in a separate change.
 *
 * Like the #670 action-gate / #742 publisher, it does no IO except through the injected store, provider, and
 * `now` seams, touches no migration / schema barrel / app-wiring registry, and the credential it forwards is a
 * token the human supplied (caps) — it never collects passwords or runs OAuth itself.
 */

import { resolveCommunityCaps, type CommunityCaps } from "./caps.js";
import { draftReply, type DraftContext, type ProductContext } from "./draft.js";
import { evaluateGate, historyFromPosts, type GateDecision } from "./gate.js";
import {
  createFakeProviderRegistry,
  isCommunityPlatform,
  type ProviderRegistry,
} from "./provider.js";
import type { CreateParticipationInput, ParticipationStore } from "./store.js";
import type {
  CommunityPlatform,
  CommunityThread,
  ParticipationDraft,
  ParticipationRecord,
  ParticipationStatus,
  ProviderPostResult,
} from "./types.js";

export interface CommunityServiceDeps {
  store: ParticipationStore;
  /** The product we participate on behalf of (name/url/topics/disclosure). */
  product: ProductContext;
  /** Platform → provider registry. Defaults to the deterministic sandbox registry (never live-participates). */
  providers?: ProviderRegistry;
  /** Resolved caps (master switch + per-platform credentials + anti-spam policy). Defaults to env-resolved caps. */
  caps?: CommunityCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** Input to {@link CommunityParticipationService.discover}. */
export interface DiscoverInput {
  workspaceId: string;
  platform: CommunityPlatform;
  /** The communities (subreddits / channels) to scan. */
  communities: string[];
  /** Soft cap on threads to fetch per call. */
  limit?: number;
  /** Optional concrete helpful points to seed each value-first draft. */
  helpfulPoints?: string[];
}

/** One discovered thread, its drafted reply, and the gate's verdict. */
export interface ParticipationCandidate {
  thread: CommunityThread;
  draft: ParticipationDraft;
  gate: GateDecision;
}

/** Input to {@link CommunityParticipationService.queue}. */
export interface QueueInput {
  workspaceId: string;
  thread: CommunityThread;
  /** Optional concrete helpful points to seed the value-first draft. */
  helpfulPoints?: string[];
}

/** Options for an approved {@link CommunityParticipationService.post}. */
export interface PostOptions {
  /** The #13 approval id that authorized this post. Required — a post never runs unapproved. */
  approvalRequestId: string;
}

const DEFAULT_DISCOVER_LIMIT = 25;

export class CommunityParticipationService {
  private readonly store: ParticipationStore;
  private readonly product: ProductContext;
  private readonly providers: ProviderRegistry;
  private readonly caps: CommunityCaps;
  private readonly now: () => Date;

  constructor(deps: CommunityServiceDeps) {
    this.store = deps.store;
    this.product = deps.product;
    this.providers = deps.providers ?? createFakeProviderRegistry();
    this.caps = deps.caps ?? resolveCommunityCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint / health check. */
  get policy(): CommunityCaps {
    return this.caps;
  }

  private draftContext(helpfulPoints?: string[]): DraftContext {
    return { product: this.product, helpfulPoints, policy: this.caps.policy };
  }

  /** Build the gate input for a thread + draft by reading the community's recent posted history. */
  private async gateFor(
    workspaceId: string,
    thread: CommunityThread,
    draft: ParticipationDraft,
  ): Promise<GateDecision> {
    const recent = await this.store.recentPosted(
      workspaceId,
      thread.platform,
      thread.communityRef,
      this.caps.policy.historyWindow,
    );
    const history = historyFromPosts(recent);
    return evaluateGate({ thread, draft, history, policy: this.caps.policy, now: this.now() });
  }

  /**
   * Discover candidate threads, draft a value-first reply for each, and run the anti-spam gate. Read-only: it
   * persists nothing and posts nothing. With the agent disabled this is an inert no-op (returns []).
   */
  async discover(input: DiscoverInput): Promise<ParticipationCandidate[]> {
    if (!this.caps.enabled) return [];
    if (!isCommunityPlatform(input.platform)) {
      throw new CommunityError(`unknown platform: ${input.platform}`);
    }
    const provider = this.providers[input.platform];
    const credential = this.caps.credentials[input.platform];
    const threads = await provider.findThreads({
      platform: input.platform,
      communities: input.communities,
      credential,
      limit: input.limit ?? DEFAULT_DISCOVER_LIMIT,
    });

    const candidates: ParticipationCandidate[] = [];
    for (const thread of threads) {
      const draft = draftReply(thread, this.draftContext(input.helpfulPoints));
      const gate = await this.gateFor(input.workspaceId, thread, draft);
      candidates.push({ thread, draft, gate });
    }
    return candidates;
  }

  /**
   * Queue a reply for approval. Drafts (or accepts a precomputed draft via re-draft), re-runs the gate, and
   * persists a `queued` record ONLY if the gate allows it. A blocked reply throws {@link CommunityGateError} and
   * is never persisted — spam cannot enter the queue. NEVER posts.
   */
  async queue(input: QueueInput): Promise<ParticipationRecord> {
    if (!isCommunityPlatform(input.thread.platform)) {
      throw new CommunityError(`unknown platform: ${input.thread.platform}`);
    }
    const draft = draftReply(input.thread, this.draftContext(input.helpfulPoints));
    const gate = await this.gateFor(input.workspaceId, input.thread, draft);
    if (gate.decision !== "allow") {
      throw new CommunityGateError(gate);
    }
    const create: CreateParticipationInput = {
      workspaceId: input.workspaceId,
      platform: input.thread.platform,
      communityRef: input.thread.communityRef,
      threadId: input.thread.id,
      threadTitle: input.thread.title,
      body: draft.body,
      mentionsProduct: draft.mentionsProduct,
      relevance: draft.relevance,
    };
    return this.store.create(create, this.now());
  }

  /** A workspace's participation records, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: ParticipationStatus): Promise<ParticipationRecord[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one participation record within a workspace. */
  async get(workspaceId: string, id: string): Promise<ParticipationRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /**
   * Post a previously-queued reply — the approved action. Order of enforcement:
   *   1. The record must exist (IDOR-scoped) and still be `queued`.
   *   2. An `approvalRequestId` is required — a post never runs from an unapproved item.
   *   3. With the agent disabled this is an inert no-op: the provider is never called and the record stays
   *      `queued` (so it can post later once enabled).
   *   4. Otherwise the platform provider is called exactly once; its result (or a caught error) becomes the
   *      terminal `posted` / `failed` outcome with the external id.
   */
  async post(workspaceId: string, id: string, opts: PostOptions): Promise<ParticipationRecord> {
    const record = await this.store.get(workspaceId, id);
    if (!record) throw new CommunityError("no such participation record");
    if (record.status !== "queued") {
      throw new CommunityError(`reply already ${record.status}`);
    }
    if (!opts.approvalRequestId || opts.approvalRequestId.trim().length === 0) {
      throw new CommunityError("post requires an approved item (no approvalRequestId)");
    }

    // (3) Disabled ⇒ inert no-op. Provider is never touched; the queued item is returned unchanged.
    if (!this.caps.enabled) {
      return record;
    }

    // (4) Post via the platform provider, forwarding the user-supplied credential.
    const provider = this.providers[record.platform];
    const credential = this.caps.credentials[record.platform];
    let result: ProviderPostResult;
    try {
      result = await provider.post({
        platform: record.platform,
        thread: {
          id: record.threadId,
          platform: record.platform,
          communityRef: record.communityRef,
          title: record.threadTitle,
          body: "",
          url: null,
          ageHours: 0,
          replyCount: 0,
          topics: [],
        },
        body: record.body,
        credential,
      });
    } catch (err) {
      // Error fallback: a thrown provider is a recorded `failed` outcome, never an unhandled rejection.
      result = {
        status: "failed",
        externalId: null,
        error: err instanceof Error ? err.message : "provider threw",
      };
    }

    const status: ParticipationStatus = result.status === "posted" ? "posted" : "failed";
    return this.commit(workspaceId, id, {
      status,
      approvalRequestId: opts.approvalRequestId,
      externalId: result.status === "posted" ? result.externalId : null,
      error: result.status === "posted" ? null : result.error ?? "post failed",
      updatedAt: this.now(),
    });
  }

  /** Apply an outcome to a still-`queued` record, surfacing the lost-race case as a clear error. */
  private async commit(
    workspaceId: string,
    id: string,
    patch: Parameters<ParticipationStore["applyOutcome"]>[2],
  ): Promise<ParticipationRecord> {
    const committed = await this.store.applyOutcome(workspaceId, id, patch);
    if (!committed) {
      throw new CommunityError("post could not be recorded (record no longer queued)");
    }
    return committed;
  }
}

/** A community-participation operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class CommunityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunityError";
  }
}

/** A queue attempt the anti-spam gate blocked. Carries the full {@link GateDecision} so a caller can explain why. */
export class CommunityGateError extends CommunityError {
  readonly gate: GateDecision;
  constructor(gate: GateDecision) {
    super(`reply blocked by anti-spam gate: ${gate.reasons.map((r) => r.code).join(", ")}`);
    this.name = "CommunityGateError";
    this.gate = gate;
  }
}
