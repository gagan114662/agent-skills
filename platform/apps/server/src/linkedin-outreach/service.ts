/**
 * The LinkedIn outreach service (issue #595) — the outreach core every B2B-outreach agent calls. It owns the
 * two-step contract that keeps reaching out safe, and enforces the daily send limit:
 *
 *   1. draft(input)                       → composes a personalized, value-first body and records a `drafted`
 *                                           touch. NOTHING sends. This is the swipe-approve item, carrying the
 *                                           per-prospect context.
 *   2. send(workspaceId, id, {approval})  → the approved action. Requires an approval id (the #13 swipe-approve
 *                                           flow), checks the per-workspace daily limit, then calls the provider
 *                                           once and logs the outcome.
 *
 * The guardrails are structural, not advisory:
 *   - `send` refuses without an `approvalRequestId` → a touch can never ship "auto", only from an approved item.
 *   - With the master switch OFF the call is an inert no-op (the provider is never touched), so the default
 *     deployment cannot send.
 *   - The daily limit is enforced before any provider call; once a workspace hits its cap, `send` throws and the
 *     touch stays `drafted` (so it can ship on a later day) — nothing is sent over the limit.
 *   - The production provider is the deterministic sandbox (`provider.ts`), so even enabled + approved does not
 *     live-send until a real transport is wired in a separate change.
 *
 * Like the #670 action-gate / #587 arbiter, it does no IO except through the injected store and `now` seams,
 * touches no migration / schema barrel / app-wiring registry, and the credential it forwards is a token the
 * human supplied (caps) — it never collects passwords or runs OAuth itself.
 */

import { composeOutreach } from "./compose.js";
import { resolveLinkedInOutreachCaps, type LinkedInOutreachCaps } from "./caps.js";
import { createFakeProvider } from "./provider.js";
import type { CreateTouchInput, OutreachStore } from "./store.js";
import type {
  OutreachContext,
  OutreachDraft,
  OutreachKind,
  OutreachProvider,
  OutreachStatus,
  OutreachTouch,
  Prospect,
  ProviderSendResult,
} from "./types.js";
import { OUTREACH_KINDS } from "./types.js";

export interface LinkedInOutreachDeps {
  store: OutreachStore;
  /** The send transport seam. Defaults to the deterministic sandbox provider (never live-sends). */
  provider?: OutreachProvider;
  /** Resolved caps (master switch + daily limit + credential). Defaults to the env-resolved caps. */
  caps?: LinkedInOutreachCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** What the caller passes to {@link LinkedInOutreachService.draft}. */
export interface DraftOutreachInput {
  workspaceId: string;
  kind: OutreachKind;
  prospect: Prospect;
  context: OutreachContext;
}

/** Options for an approved {@link LinkedInOutreachService.send}. */
export interface SendOptions {
  /** The #13 approval id that authorized this send. Required — a send never runs unapproved. */
  approvalRequestId: string;
}

/** The drafted touch plus the pure {@link OutreachDraft} it was composed from (handy for a preview). */
export interface DraftedTouch {
  touch: OutreachTouch;
  draft: OutreachDraft;
}

export class LinkedInOutreachService {
  private readonly store: OutreachStore;
  private readonly provider: OutreachProvider;
  private readonly caps: LinkedInOutreachCaps;
  private readonly now: () => Date;

  constructor(deps: LinkedInOutreachDeps) {
    this.store = deps.store;
    this.provider = deps.provider ?? createFakeProvider();
    this.caps = deps.caps ?? resolveLinkedInOutreachCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint / health check. */
  get policy(): LinkedInOutreachCaps {
    return this.caps;
  }

  /**
   * Draft a personalized, value-first touch for a prospect. Validates the kind and prospect, composes the body
   * (pure {@link composeOutreach}), then persists a `drafted` record. NEVER sends — this only creates the item a
   * human approves, with the per-prospect context attached. Returns the drafted touch and the composed draft.
   */
  async draft(input: DraftOutreachInput): Promise<DraftedTouch> {
    if (!OUTREACH_KINDS.includes(input.kind)) {
      throw new LinkedInOutreachError(`unknown outreach kind: ${input.kind}`);
    }
    if (!input.prospect || typeof input.prospect.ref !== "string" || input.prospect.ref.trim().length === 0) {
      throw new LinkedInOutreachError("a prospect ref is required to draft outreach");
    }
    const draft = composeOutreach(input.kind, input.prospect, input.context);
    const createInput: CreateTouchInput = {
      workspaceId: input.workspaceId,
      prospectRef: input.prospect.ref,
      prospect: input.prospect,
      kind: input.kind,
      body: draft.body,
    };
    const touch = await this.store.create(createInput, this.now());
    return { touch, draft };
  }

  /** A workspace's touches, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: OutreachStatus): Promise<OutreachTouch[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one touch within a workspace. */
  async get(workspaceId: string, id: string): Promise<OutreachTouch | null> {
    return this.store.get(workspaceId, id);
  }

  /** How many sends remain for this workspace today (clamped at 0). Useful for a UI hint / pre-flight check. */
  async remainingToday(workspaceId: string): Promise<number> {
    const used = await this.store.countSentSince(workspaceId, this.startOfDay(this.now()));
    return Math.max(0, this.caps.dailySendLimit - used);
  }

  /**
   * Send a previously-drafted touch — the approved action. Order of enforcement:
   *   1. The touch must exist (IDOR-scoped) and still be `drafted`.
   *   2. An `approvalRequestId` is required — a send never runs from an unapproved item.
   *   3. With the connector disabled this is an inert no-op: the provider is never called and the touch stays
   *      `drafted` (so it can send later once enabled).
   *   4. The per-workspace daily limit is enforced — at the cap, `send` throws and the touch stays `drafted`.
   *   5. Otherwise the provider is called exactly once; its result (or a caught error) becomes the terminal
   *      `sent` / `failed` outcome with the external id.
   */
  async send(workspaceId: string, id: string, opts: SendOptions): Promise<OutreachTouch> {
    const touch = await this.store.get(workspaceId, id);
    if (!touch) throw new LinkedInOutreachError("no such outreach touch");
    if (touch.status !== "drafted") {
      throw new LinkedInOutreachError(`outreach already ${touch.status}`);
    }
    if (!opts.approvalRequestId || opts.approvalRequestId.trim().length === 0) {
      throw new LinkedInOutreachError("send requires an approved item (no approvalRequestId)");
    }

    // (3) Disabled ⇒ inert no-op. Provider is never touched; the drafted item is returned unchanged.
    if (!this.caps.enabled) {
      return touch;
    }

    // (4) Daily limit ⇒ refuse before any provider call; the touch stays drafted for a later day.
    const used = await this.store.countSentSince(workspaceId, this.startOfDay(this.now()));
    if (used >= this.caps.dailySendLimit) {
      throw new LinkedInOutreachError(
        `daily outreach limit reached (${used}/${this.caps.dailySendLimit})`,
      );
    }

    // (5) Send now via the provider, forwarding the user-supplied credential.
    let result: ProviderSendResult;
    try {
      result = await this.provider.send({
        kind: touch.kind,
        prospectRef: touch.prospectRef,
        body: touch.body,
        credential: this.caps.credential,
      });
    } catch (err) {
      // Error fallback: a thrown provider is a recorded `failed` outcome, never an unhandled rejection.
      result = {
        status: "failed",
        externalId: null,
        error: err instanceof Error ? err.message : "provider threw",
      };
    }

    const status: OutreachStatus = result.status === "sent" ? "sent" : "failed";
    return this.commit(workspaceId, id, {
      status,
      approvalRequestId: opts.approvalRequestId,
      externalId: result.status === "sent" ? result.externalId : null,
      error: result.status === "sent" ? null : result.error ?? "send failed",
      updatedAt: this.now(),
    });
  }

  /** Start of the UTC day containing `at` — the daily-limit window boundary. */
  private startOfDay(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }

  /** Apply an outcome to a still-`drafted` touch, surfacing the lost-race case as a clear error. */
  private async commit(
    workspaceId: string,
    id: string,
    patch: Parameters<OutreachStore["applyOutcome"]>[2],
  ): Promise<OutreachTouch> {
    const committed = await this.store.applyOutcome(workspaceId, id, patch);
    if (!committed) {
      throw new LinkedInOutreachError("send could not be recorded (touch no longer drafted)");
    }
    return committed;
  }
}

/** A LinkedIn-outreach operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class LinkedInOutreachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedInOutreachError";
  }
}
