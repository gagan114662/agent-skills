/**
 * The action-gate service (issue #670) — the enforcement point that guarantees the acceptance criterion:
 *
 *   "no public/irreversible action executes without a recorded approval."
 *
 * It orchestrates the pure {@link classifyAction} verdict over the persisted {@link GateRequestStore} queue. The
 * SHAPE is the guarantee — there is no method that returns a green light for a public/irreversible action without
 * a matching, recorded, human approval:
 *
 *   1. {@link guardAction}  — an actuator calls this BEFORE acting. It never executes anything. If the action is
 *      internal+reversible it returns `allowed:true` (autonomous). Otherwise it PARKS a `pending` request in the
 *      recorded queue and returns `allowed:false` with that request; the actuator must stop.
 *   2. {@link approve} / {@link reject} — a human records the decision on a pending request.
 *   3. {@link consumeApproval} — the actuator retries here with the SAME action. It only ever returns the
 *      request (a green light) when an `approved`, unexpired request whose fingerprint matches the action is
 *      atomically flipped to `executed` (single-use). Every other case throws — there is no autonomous path.
 *
 * The module is RECORDED-ONLY: it never performs the publish/send/post/delete itself (the actuator does that,
 * after `consumeApproval` returns). Like the #674 content-guard it does no IO except through the injected store
 * and `now` seams, touches no migration / schema barrel / app-wiring registry, and the safety property is ALWAYS
 * on — it cannot be configured off.
 */

import {
  actionFingerprint,
  classifyAction,
  type ActionClassification,
  type ActionDescriptor,
} from "./classify.js";
import { resolveActionGateCaps, type ActionGateCaps } from "./caps.js";
import type { GateRequest, GateRequestStatus, GateRequestStore } from "./store.js";

export interface ActionGateDeps {
  store: GateRequestStore;
  /** Resolved caps (TTL + extra verb sets). Defaults to the env-resolved caps. */
  caps?: ActionGateCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** The input an actuator passes to {@link ActionGateService.guardAction} / {@link consumeApproval}. */
export interface GuardInput {
  workspaceId: string;
  /** The member on whose behalf the action is proposed (the requester recorded on the parked request). */
  requesterMemberId: string;
  action: ActionDescriptor;
}

/** The verdict {@link ActionGateService.guardAction} returns. */
export interface GuardResult {
  /** `true` only for an internal+reversible action that may run autonomously; `false` means a request was parked. */
  allowed: boolean;
  classification: ActionClassification;
  /** The parked `pending` request when `allowed:false`; `null` when the action ran autonomously. */
  request: GateRequest | null;
  reason: string;
}

export class ActionGateService {
  private readonly store: GateRequestStore;
  private readonly caps: ActionGateCaps;
  private readonly now: () => Date;

  constructor(deps: ActionGateDeps) {
    this.store = deps.store;
    this.caps = deps.caps ?? resolveActionGateCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Classify an action without touching the queue — the pure verdict, useful for a dry-run / UI hint. */
  classify(action: ActionDescriptor): ActionClassification {
    return classifyAction(action, this.caps);
  }

  /**
   * The pre-action checkpoint. Returns `allowed:true` ONLY for an internal+reversible action (it may run
   * autonomously). For any public / irreversible / uncertain action it parks a `pending` request in the recorded
   * queue and returns `allowed:false` — the actuator MUST NOT execute. Never runs the action itself.
   */
  async guardAction(input: GuardInput): Promise<GuardResult> {
    const classification = this.classify(input.action);
    if (!classification.mustConfirm) {
      return {
        allowed: true,
        classification,
        request: null,
        reason: classification.reason,
      };
    }

    const now = this.now();
    const request = await this.store.create({
      workspaceId: input.workspaceId,
      actionType: input.action.action,
      surface: input.action.surface ?? null,
      summary: input.action.summary ?? null,
      klass: classification.klass,
      fingerprint: actionFingerprint(input.action),
      requestedByMemberId: input.requesterMemberId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + this.caps.approvalTtlMs),
    });

    return {
      allowed: false,
      classification,
      request,
      reason: `parked for human approval: ${classification.reason}`,
    };
  }

  /** A workspace's gate queue, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: GateRequestStatus): Promise<GateRequest[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one gate request within a workspace. Lazily reflects expiry of an un-actioned pending request. */
  async get(workspaceId: string, id: string): Promise<GateRequest | null> {
    const req = await this.store.get(workspaceId, id);
    if (!req) return null;
    return this.lazilyExpire(req);
  }

  /**
   * Record a human APPROVAL on a pending request — the recorded yes the acceptance criterion demands. Refuses to
   * approve an expired request (it is lazily expired instead). Optionally enforces that the approver is not the
   * requester (an agent can never approve its own gate — ADR-0013 / #200 §4) when {@link forbidSelf} is set.
   */
  async approve(
    workspaceId: string,
    id: string,
    approverMemberId: string,
    opts: { reason?: string | null; forbidSelfApproval?: boolean } = {},
  ): Promise<GateRequest> {
    const current = await this.requirePending(workspaceId, id);
    if (opts.forbidSelfApproval && current.requestedByMemberId === approverMemberId) {
      throw new ActionGateError("an action cannot be approved by its own requester (no self-approval)");
    }
    const decided = await this.store.decide(workspaceId, id, {
      status: "approved",
      decidedByMemberId: approverMemberId,
      decidedAt: this.now(),
      reason: opts.reason ?? null,
    });
    if (!decided) throw new ActionGateError("approval could not be recorded (request no longer pending)");
    return decided;
  }

  /** Record a human REJECTION on a pending request — the action is denied and can never execute. */
  async reject(
    workspaceId: string,
    id: string,
    approverMemberId: string,
    reason: string | null = null,
  ): Promise<GateRequest> {
    await this.requirePending(workspaceId, id);
    const decided = await this.store.decide(workspaceId, id, {
      status: "rejected",
      decidedByMemberId: approverMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) throw new ActionGateError("rejection could not be recorded (request no longer pending)");
    return decided;
  }

  /**
   * The ONLY path from an approval to execution. The actuator calls this with the SAME action it parked; the
   * service consumes the approval exactly once and returns the now-`executed` request. The action may run only
   * after this returns. Throws (never returns) when there is no valid recorded approval:
   *   - request missing                          → not found;
   *   - request not `approved` (pending/rejected/executed/expired) → not approved / already used;
   *   - request expired                          → expired (and lazily marked so);
   *   - fingerprint mismatch                     → the approval was granted for a DIFFERENT action (replay).
   * The atomic `approved → executed` flip in the store guarantees a single approval can authorize at most one
   * execution.
   */
  async consumeApproval(input: GuardInput & { requestId: string }): Promise<GateRequest> {
    const { workspaceId, requestId } = input;
    const req = await this.store.get(workspaceId, requestId);
    if (!req) throw new ActionGateError("no such approval request");

    if (req.status !== "approved") {
      // Surface a precise reason; lazily expire a pending request whose TTL has passed.
      if (req.status === "pending" && this.isExpired(req)) {
        await this.store.markExpired(workspaceId, requestId, this.now());
        throw new ActionGateError("approval expired before it was used");
      }
      throw new ActionGateError(`action not authorized: request is ${req.status}, not approved`);
    }

    if (this.isExpired(req)) {
      await this.store.markExpired(workspaceId, requestId, this.now());
      throw new ActionGateError("approval expired before it was used");
    }

    const fingerprint = actionFingerprint(input.action);
    if (fingerprint !== req.fingerprint) {
      throw new ActionGateError(
        "approval does not match this action — it was granted for a different action (replay refused)",
      );
    }

    const executed = await this.store.markExecuted(workspaceId, requestId, this.now());
    if (!executed) {
      // Lost a race: another caller consumed it first (single-use enforced by the store).
      throw new ActionGateError("approval already consumed");
    }
    return executed;
  }

  /** Whether `req` is past its TTL deadline as of now. */
  private isExpired(req: GateRequest): boolean {
    return req.expiresAt.getTime() <= this.now().getTime();
  }

  /** Reflect (and persist) lazy expiry of a pending request when read. */
  private async lazilyExpire(req: GateRequest): Promise<GateRequest> {
    if (req.status === "pending" && this.isExpired(req)) {
      return (await this.store.markExpired(req.workspaceId, req.id, this.now())) ?? req;
    }
    return req;
  }

  private async requirePending(workspaceId: string, id: string): Promise<GateRequest> {
    const req = await this.store.get(workspaceId, id);
    if (!req) throw new ActionGateError("no such approval request");
    if (req.status === "pending" && this.isExpired(req)) {
      await this.store.markExpired(workspaceId, id, this.now());
      throw new ActionGateError("request expired before a decision was recorded");
    }
    if (req.status !== "pending") throw new ActionGateError(`request already ${req.status}`);
    return req;
  }
}

/** A gate operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class ActionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionGateError";
  }
}
