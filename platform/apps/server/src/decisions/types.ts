/**
 * Shared decision store (issue #513) — public types.
 *
 * A *decision* is a first-class record an agent captures (topic + title + rationale + who) so its
 * teammates can recall it before deciding, instead of re-deriving context every run. A decision is a
 * record, never an action: anything external/money it implies is parked behind the #13 approval gate and
 * only referenced here. All user-facing fields are sanitized of internal agent chatter at the write site.
 */

export type DecisionStatus = "recorded" | "superseded";

/** What the caller asks to record. `external` routes the implied action through the #13 gate. */
export interface RecordDecisionRequest {
  workspaceId: string;
  /** the deciding member (agent or human). */
  decidedByMemberId: string;
  /** the subject decided about (brand/channel/product/topic) — the recall key. */
  topic: string;
  /** the decision, one line. */
  title: string;
  /** why. */
  rationale: string;
  /** optional #14 task this decision served. */
  taskId?: string | null;
  /** when set, the decision implies an external/money action that must clear the #13 gate first. */
  external?: {
    actionType: string;
    /** money amount in the smallest unit, or null for a non-money external action. */
    amount: number | null;
    summary: string;
    payload?: Record<string, unknown>;
  } | null;
}

/** The recorded decision, in user-safe form (no internal chatter, dedup applied). */
export interface RecordedDecision {
  id: string;
  topic: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  /** the #15 graph node this decision mirrors into (browsable). */
  memoryId: string | null;
  taskId: string | null;
  /** the #13 request the implied external/money action is parked behind, if any. */
  approvalRequestId: string | null;
  /** true ⇒ an external/money action is awaiting human approval (it did NOT execute). */
  pendingApproval: boolean;
  /** false ⇒ this decision already existed (idempotent re-record collapsed to the prior row). */
  created: boolean;
}

/** A decision as recalled for reuse — the minimal, clean shape an agent or the UI consumes. */
export interface RecalledDecision {
  id: string;
  topic: string;
  title: string;
  rationale: string;
  decidedAt: Date;
}

/** The recall payload an agent gets before deciding: the rows plus a ready-to-read brief. */
export interface DecisionRecall {
  decisions: RecalledDecision[];
  /** a chatter-free, human-readable summary of the prior decisions (empty when none). */
  brief: string;
}
