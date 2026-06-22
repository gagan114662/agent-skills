/**
 * The conflict-resolution service (issue #587) — the arbitration step the orchestrator calls before any
 * competing strategy ships. It runs the pure {@link resolveConflict} verdict over the persisted
 * {@link ConflictStore} and guarantees the acceptance criteria:
 *
 *   1. "competing proposals never both ship" — every objective yields at most ONE shippable proposal id
 *      ({@link shippableProposalId}). A `merge`/`pick` records the single winner; an `escalate` records ZERO
 *      shippable until a human decides, then exactly one.
 *   2. "the user sees one clear decision when arbitration escalates" — an escalation parks ONE record in the
 *      workspace's queue presenting the candidate strategies, resolved by a single human choice via {@link decide}.
 *
 * Like the #670 action-gate it does no IO except through the injected store and `now` seams, touches no
 * migration / schema barrel / app-wiring registry, and cannot be configured off.
 */

import { resolveConflict } from "./detect.js";
import { resolveConflictResolutionCaps, type ConflictResolutionCaps } from "./caps.js";
import type {
  ConflictRecord,
  ConflictStatus,
  ConflictStore,
} from "./store.js";
import type { ConflictResolution, Proposal } from "./types.js";

export interface ConflictResolutionDeps {
  store: ConflictStore;
  /** Resolved caps (weights, margin, role precedence, TTL). Defaults to the env-resolved caps. */
  caps?: ConflictResolutionCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** The input the orchestrator passes to {@link ConflictResolutionService.arbitrate}. */
export interface ArbitrateInput {
  workspaceId: string;
  /** The member/agent on whose behalf arbitration runs (recorded as the requester). */
  requesterMemberId?: string | null;
  /** All proposals for ONE objective. Must be non-empty and share a single `objectiveId`. */
  proposals: Proposal[];
}

/** The result of an arbitration: the pure verdict plus the persisted record it produced. */
export interface ArbitrateResult {
  resolution: ConflictResolution;
  record: ConflictRecord;
}

export class ConflictResolutionService {
  private readonly store: ConflictStore;
  private readonly caps: ConflictResolutionCaps;
  private readonly now: () => Date;

  constructor(deps: ConflictResolutionDeps) {
    this.store = deps.store;
    this.caps = deps.caps ?? resolveConflictResolutionCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint or dry-run. */
  get policy(): ConflictResolutionCaps {
    return this.caps;
  }

  /** Run the pure verdict without persisting — a dry-run / preview the orchestrator can show before committing. */
  preview(proposals: Proposal[]): ConflictResolution {
    return resolveConflict(proposals, this.caps);
  }

  /**
   * Arbitrate one objective's competing proposals and persist the outcome. A `merge`/`pick` is recorded terminal
   * (`auto_resolved`) with its single winner; an `escalate` is parked (`escalated`) with a TTL for a human to
   * decide. Returns the verdict and the stored record. Never ships anything itself.
   */
  async arbitrate(input: ArbitrateInput): Promise<ArbitrateResult> {
    const resolution = resolveConflict(input.proposals, this.caps);
    const now = this.now();
    const escalated = resolution.outcome === "escalate";
    const record = await this.store.create({
      workspaceId: input.workspaceId,
      objectiveId: resolution.objectiveId,
      status: escalated ? "escalated" : "auto_resolved",
      outcome: resolution.outcome,
      winnerProposalId: resolution.winnerProposalId,
      candidates: input.proposals,
      reason: resolution.reason,
      requestedByMemberId: input.requesterMemberId ?? null,
      requestedAt: now,
      expiresAt: escalated ? new Date(now.getTime() + this.caps.decisionTtlMs) : null,
    });
    return { resolution, record };
  }

  /** A workspace's conflict queue, newest first, optionally filtered by status. */
  async list(workspaceId: string, status?: ConflictStatus): Promise<ConflictRecord[]> {
    return this.store.list(workspaceId, status);
  }

  /** Load one conflict record within a workspace. Lazily reflects expiry of an un-actioned escalation. */
  async get(workspaceId: string, id: string): Promise<ConflictRecord | null> {
    const rec = await this.store.get(workspaceId, id);
    if (!rec) return null;
    return this.lazilyExpire(rec);
  }

  /**
   * Record a human decision on an escalated conflict: the member picks ONE of the candidate proposals as the
   * winner. Refuses a pick that is not among the candidates, and refuses an expired escalation (it is lazily
   * expired instead). After this returns, exactly one proposal is shippable for the objective.
   */
  async decide(
    workspaceId: string,
    id: string,
    deciderMemberId: string,
    winnerProposalId: string,
    reason: string | null = null,
  ): Promise<ConflictRecord> {
    const current = await this.requireEscalated(workspaceId, id);
    if (!current.candidates.some((p) => p.id === winnerProposalId)) {
      throw new ConflictResolutionError(
        "chosen winner is not one of the conflict's candidate proposals",
      );
    }
    const decided = await this.store.decide(workspaceId, id, {
      winnerProposalId,
      decidedByMemberId: deciderMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) {
      throw new ConflictResolutionError("decision could not be recorded (conflict no longer escalated)");
    }
    return decided;
  }

  /** Whether `rec` is an escalation past its TTL deadline as of now. */
  private isExpired(rec: ConflictRecord): boolean {
    return rec.status === "escalated" && rec.expiresAt !== null && rec.expiresAt.getTime() <= this.now().getTime();
  }

  /** Reflect (and persist) lazy expiry of an escalated record when read. */
  private async lazilyExpire(rec: ConflictRecord): Promise<ConflictRecord> {
    if (this.isExpired(rec)) {
      return (await this.store.markExpired(rec.workspaceId, rec.id, this.now())) ?? rec;
    }
    return rec;
  }

  private async requireEscalated(workspaceId: string, id: string): Promise<ConflictRecord> {
    const rec = await this.store.get(workspaceId, id);
    if (!rec) throw new ConflictResolutionError("no such conflict record");
    if (this.isExpired(rec)) {
      await this.store.markExpired(workspaceId, id, this.now());
      throw new ConflictResolutionError("escalation expired before a decision was recorded");
    }
    if (rec.status !== "escalated") {
      throw new ConflictResolutionError(`conflict already ${rec.status}`);
    }
    return rec;
  }
}

/**
 * The single proposal cleared to ship for a recorded conflict — the structural enforcement of "competing
 * proposals never both ship". Returns the winner for `auto_resolved` / `resolved`, and `null` while `escalated`
 * (pending a human) or `expired` (nothing ships). It is impossible for this to return two ids.
 */
export function shippableProposalId(record: ConflictRecord): string | null {
  switch (record.status) {
    case "auto_resolved":
    case "resolved":
      return record.winnerProposalId;
    case "escalated":
    case "expired":
      return null;
  }
}

/** A conflict-resolution operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class ConflictResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictResolutionError";
  }
}
