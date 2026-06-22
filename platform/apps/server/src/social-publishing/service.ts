/**
 * The social publishing service (issue #742) — the publishing core every distribution agent calls. It owns the
 * two-step contract that keeps public posting safe:
 *
 *   1. queue(input)                         → records a `queued` item. NOTHING posts. This is the swipe-approve item.
 *   2. publish(workspaceId, id, {approval}) → the approved action. Requires an approval id (the #13 swipe-approve
 *                                             flow), then either schedules (future `scheduleAt`) or calls the
 *                                             platform provider once and records the external id.
 *
 * The guardrails are structural, not advisory:
 *   - `publish` refuses without an `approvalRequestId` → a post can never ship "auto", only from an approved item.
 *   - With the master switch OFF the call is an inert no-op (the provider is never touched), so the default
 *     deployment cannot post.
 *   - The production provider registry is the deterministic sandbox (`provider.ts`), so even enabled + approved
 *     does not live-post until a real transport is wired in a separate change.
 *
 * Like the #670 action-gate / #587 arbiter, it does no IO except through the injected store and `now` seams,
 * touches no migration / schema barrel / app-wiring registry, and the credential it forwards is a token the
 * human supplied (caps) — it never collects passwords or runs OAuth itself.
 */

import { resolveSocialPublishingCaps, type SocialPublishingCaps } from "./caps.js";
import { createFakeProviderRegistry, isSocialPlatform, type ProviderRegistry } from "./provider.js";
import type { CreatePublishInput, PublishStore } from "./store.js";
import type {
  ProviderPublishResult,
  PublishRecord,
  PublishStatus,
  SocialPlatform,
} from "./types.js";

export interface SocialPublishingDeps {
  store: PublishStore;
  /** Platform → provider registry. Defaults to the deterministic sandbox registry (never live-posts). */
  providers?: ProviderRegistry;
  /** Resolved caps (master switch + per-platform credentials). Defaults to the env-resolved caps. */
  caps?: SocialPublishingCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** What the caller passes to {@link SocialPublishingService.queue}. */
export interface QueuePublishInput {
  workspaceId: string;
  platform: SocialPlatform;
  /** The rendered asset reference to publish. */
  asset: CreatePublishInput["asset"];
  caption: string;
  /** ISO instant to publish at, or null/undefined to publish on approval. */
  scheduleAt?: Date | null;
}

/** Options for an approved {@link SocialPublishingService.publish}. */
export interface PublishOptions {
  /** The #13 approval id that authorized this publish. Required — a publish never runs unapproved. */
  approvalRequestId: string;
}

export class SocialPublishingService {
  private readonly store: PublishStore;
  private readonly providers: ProviderRegistry;
  private readonly caps: SocialPublishingCaps;
  private readonly now: () => Date;

  constructor(deps: SocialPublishingDeps) {
    this.store = deps.store;
    this.providers = deps.providers ?? createFakeProviderRegistry();
    this.caps = deps.caps ?? resolveSocialPublishingCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint / health check. */
  get policy(): SocialPublishingCaps {
    return this.caps;
  }

  /**
   * Queue a publish. Validates the platform and asset, then persists a `queued` record. NEVER posts — this only
   * creates the item a human approves. Returns the queued record.
   */
  async queue(input: QueuePublishInput): Promise<PublishRecord> {
    if (!isSocialPlatform(input.platform)) {
      throw new SocialPublishingError(`unknown platform: ${input.platform}`);
    }
    if (!input.asset || typeof input.asset.ref !== "string" || input.asset.ref.trim().length === 0) {
      throw new SocialPublishingError("an asset ref is required to queue a publish");
    }
    return this.store.create(
      {
        workspaceId: input.workspaceId,
        platform: input.platform,
        asset: input.asset,
        caption: input.caption,
        scheduleAt: input.scheduleAt ?? null,
      },
      this.now(),
    );
  }

  /** A workspace's publish records, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: PublishStatus): Promise<PublishRecord[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one publish record within a workspace. */
  async get(workspaceId: string, id: string): Promise<PublishRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /**
   * Publish a previously-queued item — the approved action. Order of enforcement:
   *   1. The record must exist (IDOR-scoped) and still be `queued`.
   *   2. An `approvalRequestId` is required — a publish never runs from an unapproved item.
   *   3. With the connector disabled this is an inert no-op: the provider is never called and the record stays
   *      `queued` (so it can publish later once enabled).
   *   4. A future `scheduleAt` records `scheduled` (a due-time worker publishes later) WITHOUT calling a provider.
   *   5. Otherwise the platform provider is called exactly once; its result (or a caught error) becomes the
   *      terminal `published` / `failed` outcome with the external id.
   */
  async publish(workspaceId: string, id: string, opts: PublishOptions): Promise<PublishRecord> {
    const record = await this.store.get(workspaceId, id);
    if (!record) throw new SocialPublishingError("no such publish record");
    if (record.status !== "queued") {
      throw new SocialPublishingError(`publish already ${record.status}`);
    }
    if (!opts.approvalRequestId || opts.approvalRequestId.trim().length === 0) {
      throw new SocialPublishingError("publish requires an approved item (no approvalRequestId)");
    }

    // (3) Disabled ⇒ inert no-op. Provider is never touched; the queued item is returned unchanged.
    if (!this.caps.enabled) {
      return record;
    }

    // (4) Future schedule ⇒ defer. Record the approval, mark `scheduled`, do NOT call a provider yet.
    const now = this.now();
    if (record.scheduleAt && record.scheduleAt.getTime() > now.getTime()) {
      return this.commit(workspaceId, id, {
        status: "scheduled",
        approvalRequestId: opts.approvalRequestId,
        externalId: null,
        error: null,
        updatedAt: now,
      });
    }

    // (5) Publish now via the platform provider, forwarding the user-supplied credential.
    const provider = this.providers[record.platform];
    const credential = this.caps.credentials[record.platform];
    let result: ProviderPublishResult;
    try {
      result = await provider.publish({
        platform: record.platform,
        asset: record.asset,
        caption: record.caption,
        scheduleAt: record.scheduleAt,
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

    const status: PublishStatus = result.status === "published" ? "published" : "failed";
    return this.commit(workspaceId, id, {
      status,
      approvalRequestId: opts.approvalRequestId,
      externalId: result.status === "published" ? result.externalId : null,
      error: result.status === "published" ? null : result.error ?? "publish failed",
      updatedAt: this.now(),
    });
  }

  /** Apply an outcome to a still-`queued` record, surfacing the lost-race case as a clear error. */
  private async commit(
    workspaceId: string,
    id: string,
    patch: Parameters<PublishStore["applyOutcome"]>[2],
  ): Promise<PublishRecord> {
    const committed = await this.store.applyOutcome(workspaceId, id, patch);
    if (!committed) {
      throw new SocialPublishingError("publish could not be recorded (record no longer queued)");
    }
    return committed;
  }
}

/** A social-publishing operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class SocialPublishingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialPublishingError";
  }
}
