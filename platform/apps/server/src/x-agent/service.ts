/**
 * The X agent service (issue #596) — the posting + engagement core every distribution agent calls. It owns the
 * contract that keeps public posting/engaging safe:
 *
 *   1. draftPost / draftThread / draftReply / queueEngagement → records a `draft` item. NOTHING ships. This is
 *      the swipe-approve item.
 *   2. publish(workspaceId, id, {approvalRequestId})          → the approved action. Requires an approval id
 *      (the #13 swipe-approve flow), then either schedules (future `scheduleAt`) or calls the provider once and
 *      records the external id.
 *   3. reverse(workspaceId, id, {approvalRequestId})          → undoes a published engagement (delete reply,
 *      unlike, un-repost). Also approval-gated — a reversal is an outbound action too — and records who approved
 *      it and when, satisfying the acceptance "engagement actions are logged and reversible".
 *
 * The guardrails are structural, not advisory:
 *   - `publish`/`reverse` refuse without an `approvalRequestId` → an action can never ship "auto", only from an
 *     approved item.
 *   - With the master switch OFF every call is an inert no-op (the provider is never touched), so the default
 *     deployment cannot post or engage.
 *   - The production provider is the deterministic sandbox (`provider.ts`), so even enabled + approved does not
 *     live-post until a real transport is wired in a separate change.
 *
 * Like the #670 action-gate / #742 social-publishing service, it does no IO except through the injected store
 * and `now` seams, touches no migration / schema barrel / app-wiring registry, and the credential it forwards is
 * a token the human supplied (caps) — it never collects passwords or runs OAuth itself.
 */

import { resolveXAgentCaps, type XAgentCaps } from "./caps.js";
import {
  composePost,
  composeReply,
  composeThread,
  type ComposePostInput,
  type ComposeReplyInput,
  type ComposeThreadInput,
} from "./compose.js";
import { createFakeXProvider } from "./provider.js";
import type { CreateActionInput, XActionStore } from "./store.js";
import {
  isEngagementKind,
  type ProviderPublishResult,
  type ProviderReverseResult,
  type XActionKind,
  type XActionRecord,
  type XActionStatus,
  type XProvider,
} from "./types.js";

export interface XAgentDeps {
  store: XActionStore;
  /** The publish/reverse provider. Defaults to the deterministic sandbox (never live-posts). */
  provider?: XProvider;
  /** Resolved caps (master switch + credential). Defaults to the env-resolved caps. */
  caps?: XAgentCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** Options for an approved {@link XAgentService.publish} / {@link XAgentService.reverse}. */
export interface ApprovalOptions {
  /** The #13 approval id that authorized this action. Required — an action never runs unapproved. */
  approvalRequestId: string;
}

/** A bare engagement (like/repost) on an external tweet — no composed content of our own. */
export interface QueueEngagementInput {
  workspaceId: string;
  /** Must be `like` or `repost` (a `reply` is drafted via {@link XAgentService.draftReply}). */
  kind: Extract<XActionKind, "like" | "repost">;
  targetTweetId: string;
  scheduleAt?: Date | null;
}

export class XAgentService {
  private readonly store: XActionStore;
  private readonly provider: XProvider;
  private readonly caps: XAgentCaps;
  private readonly now: () => Date;

  constructor(deps: XAgentDeps) {
    this.store = deps.store;
    this.provider = deps.provider ?? createFakeXProvider();
    this.caps = deps.caps ?? resolveXAgentCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint / health check. */
  get policy(): XAgentCaps {
    return this.caps;
  }

  /**
   * Draft an on-brand original post from a calendar topic. Composes the text via the pure core and persists a
   * `draft` record. NEVER posts — this only creates the item a human approves.
   */
  async draftPost(
    workspaceId: string,
    input: ComposePostInput,
    scheduleAt: Date | null = null,
  ): Promise<XActionRecord> {
    const { text } = composePost(input);
    return this.create({ workspaceId, kind: "post", content: { text }, targetTweetId: null, scheduleAt });
  }

  /** Draft an on-brand thread from a topic + ordered points. Persists a `draft` record; posts nothing. */
  async draftThread(
    workspaceId: string,
    input: ComposeThreadInput,
    scheduleAt: Date | null = null,
  ): Promise<XActionRecord> {
    const { tweets } = composeThread(input);
    return this.create({ workspaceId, kind: "thread", content: { tweets }, targetTweetId: null, scheduleAt });
  }

  /**
   * Draft a reply into a relevant conversation. Composes the reply via the pure core (which never echoes the
   * target tweet's prose) and persists a `draft` engagement record; posts nothing.
   */
  async draftReply(
    workspaceId: string,
    input: ComposeReplyInput,
    scheduleAt: Date | null = null,
  ): Promise<XActionRecord> {
    const { text, targetTweetId } = composeReply(input);
    return this.create({ workspaceId, kind: "reply", content: { text }, targetTweetId, scheduleAt });
  }

  /**
   * Queue a bare engagement (like / repost) on an external tweet. No content is composed. Persists a `draft`
   * record; performs nothing until approved + published.
   */
  async queueEngagement(input: QueueEngagementInput): Promise<XActionRecord> {
    const targetTweetId = input.targetTweetId.trim();
    if (!targetTweetId) throw new XAgentError("a targetTweetId is required to engage");
    return this.create({
      workspaceId: input.workspaceId,
      kind: input.kind,
      content: {},
      targetTweetId,
      scheduleAt: input.scheduleAt ?? null,
    });
  }

  /** A workspace's action records, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: XActionStatus): Promise<XActionRecord[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one action record within a workspace. */
  async get(workspaceId: string, id: string): Promise<XActionRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /**
   * Publish a previously-drafted action — the approved action. Order of enforcement:
   *   1. The record must exist (IDOR-scoped) and still be `draft`.
   *   2. An `approvalRequestId` is required — an action never runs from an unapproved item.
   *   3. With the agent disabled this is an inert no-op: the provider is never called and the record stays
   *      `draft` (so it can publish later once enabled).
   *   4. A future `scheduleAt` records `scheduled` (a due-time worker publishes later) WITHOUT calling a provider.
   *   5. Otherwise the provider is called exactly once; its result (or a caught error) becomes the terminal
   *      `published` / `failed` outcome with the external id.
   */
  async publish(workspaceId: string, id: string, opts: ApprovalOptions): Promise<XActionRecord> {
    const record = await this.store.get(workspaceId, id);
    if (!record) throw new XAgentError("no such action");
    if (record.status !== "draft") throw new XAgentError(`action already ${record.status}`);
    requireApproval(opts, "publish");

    // (3) Disabled ⇒ inert no-op. Provider is never touched; the draft is returned unchanged.
    if (!this.caps.enabled) return record;

    // (4) Future schedule ⇒ defer. Record the approval, mark `scheduled`, do NOT call a provider yet.
    const now = this.now();
    if (record.scheduleAt && record.scheduleAt.getTime() > now.getTime()) {
      return this.commitPublish(workspaceId, id, {
        status: "scheduled",
        approvalRequestId: opts.approvalRequestId,
        externalId: null,
        error: null,
        updatedAt: now,
      });
    }

    // (5) Publish now via the provider, forwarding the user-supplied credential.
    let result: ProviderPublishResult;
    try {
      result = await this.provider.publish({
        kind: record.kind,
        content: record.content,
        targetTweetId: record.targetTweetId,
        scheduleAt: record.scheduleAt,
        credential: this.caps.credential,
      });
    } catch (err) {
      result = { status: "failed", externalId: null, error: err instanceof Error ? err.message : "provider threw" };
    }

    const status: XActionStatus = result.status === "published" ? "published" : "failed";
    return this.commitPublish(workspaceId, id, {
      status,
      approvalRequestId: opts.approvalRequestId,
      externalId: result.status === "published" ? result.externalId : null,
      error: result.status === "published" ? null : result.error ?? "publish failed",
      updatedAt: this.now(),
    });
  }

  /**
   * Reverse a previously-published action — undo a public engagement. Approval-gated like publish (a reversal is
   * itself an outbound action). Order of enforcement:
   *   1. The record must exist (IDOR-scoped) and currently be `published` with an `externalId` to undo.
   *   2. An `approvalRequestId` is required.
   *   3. Disabled ⇒ inert no-op: the record stays `published` (reverse later once enabled).
   *   4. Otherwise the provider's `reverse` is called once; on success the record becomes `reversed` (logging
   *      who approved it and when); a failure leaves it `published` and surfaces the error.
   */
  async reverse(workspaceId: string, id: string, opts: ApprovalOptions): Promise<XActionRecord> {
    const record = await this.store.get(workspaceId, id);
    if (!record) throw new XAgentError("no such action");
    if (record.status !== "published") throw new XAgentError(`only a published action can be reversed (is ${record.status})`);
    if (!record.externalId) throw new XAgentError("published action has no external id to reverse");
    requireApproval(opts, "reverse");

    // (3) Disabled ⇒ inert no-op. Provider untouched; record unchanged.
    if (!this.caps.enabled) return record;

    // (4) Reverse via the provider.
    let result: ProviderReverseResult;
    try {
      result = await this.provider.reverse({
        kind: record.kind,
        externalId: record.externalId,
        targetTweetId: record.targetTweetId,
        credential: this.caps.credential,
      });
    } catch (err) {
      result = { status: "failed", error: err instanceof Error ? err.message : "provider threw" };
    }

    if (result.status !== "reversed") {
      throw new XAgentError(`reverse failed: ${result.error ?? "unknown error"}`);
    }
    const now = this.now();
    const committed = await this.store.applyReverseOutcome(workspaceId, id, {
      reverseApprovalRequestId: opts.approvalRequestId,
      reversedAt: now,
      updatedAt: now,
    });
    if (!committed) throw new XAgentError("reverse could not be recorded (record no longer published)");
    return committed;
  }

  /** True when this kind needs an external target (engagement). Re-exported for callers building UIs. */
  isEngagement(kind: XActionKind): boolean {
    return isEngagementKind(kind);
  }

  private async create(input: CreateActionInput): Promise<XActionRecord> {
    return this.store.create(input, this.now());
  }

  /** Apply a publish outcome to a still-`draft` record, surfacing the lost-race case as a clear error. */
  private async commitPublish(
    workspaceId: string,
    id: string,
    patch: Parameters<XActionStore["applyPublishOutcome"]>[2],
  ): Promise<XActionRecord> {
    const committed = await this.store.applyPublishOutcome(workspaceId, id, patch);
    if (!committed) throw new XAgentError("publish could not be recorded (record no longer draft)");
    return committed;
  }
}

/** Guard: an outbound action requires a non-empty approval id. */
function requireApproval(opts: ApprovalOptions, action: string): void {
  if (!opts.approvalRequestId || opts.approvalRequestId.trim().length === 0) {
    throw new XAgentError(`${action} requires an approved item (no approvalRequestId)`);
  }
}

/** An X-agent operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class XAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XAgentError";
  }
}
