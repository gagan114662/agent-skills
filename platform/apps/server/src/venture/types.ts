import type { PersonaScorecard, RubricDimension } from "./rubric.js";

/**
 * Typed artifacts for the Venture Loop (#96). These are the loop's structured feedback surfaces —
 * the intake idea, the evidence, the dual-persona scorecard, the gap list, and the iteration log —
 * persisted via `db/repositories/venture.ts`.
 */

/** The four terminal/continue verdicts of the gate. */
export type Verdict = "FUND" | "ITERATE" | "KILL" | "ESCALATE";

/** Thresholds that parameterize the pure decision — supplied from config (`resolveVentureCaps`). */
export interface VentureThresholds {
  /** Score at/above which the idea is FUNDed. */
  fund: number;
  /** Score at/below which the idea is KILLed. */
  kill: number;
  /** Width of the borderline band just below `fund` that ESCALATEs instead of iterating. */
  escalateBand: number;
  /** Max passes before the loop exits to a human (the max-iteration termination). */
  maxIterations: number;
}

/** Lifecycle of an idea as it moves through the loop. */
export type IdeaStatus = "intake" | "scoring" | "iterating" | "funded" | "killed" | "escalated";

/** The intake artifact a caller submits (#96 step 1 SOURCE). */
export interface IdeaInput {
  problem: string;
  targetUser: string;
  insight: string;
  wedge: string;
  marketPath: string;
}

/** A persisted idea. */
export interface VentureIdea extends IdeaInput {
  id: string;
  workspaceId: string;
  status: IdeaStatus;
  /** The epic task emitted on FUND (null until funded). */
  epicTaskId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
}

/** One evidence item (#96 step 2 RESEARCH): a claim with a source, or marked an assumption. */
export interface Evidence {
  claim: string;
  /** A citation/source for the claim, or null when it is an unverified assumption. */
  source: string | null;
  /** True when there is no source — the claim is an assumption to be validated. */
  assumption: boolean;
}

/** A persisted scorecard (#96 step 3 SCORE): the combined numeric verdict of the two personas. */
export interface Scorecard {
  id: string;
  workspaceId: string;
  ideaId: string;
  iteration: number;
  /** Adversarially-weighted aggregate, 0–100. */
  score: number;
  /** Verdict stamped after `decide` runs (null between SCORE and DECIDE). */
  verdict: Verdict | null;
  advocate: PersonaScorecard;
  reviewer: PersonaScorecard;
  reasoning: string;
  /** True only for a FUND scorecard — the admission gate keys off this + `expiresAt`. */
  funded: boolean;
  createdAt: Date;
  expiresAt: Date;
}

/** The structured gap list fed into the next pass on ITERATE. */
export interface GapList {
  gaps: { dimension: RubricDimension; note: string }[];
}

/** Whether an evaluation is still iterating or has reached a terminal verdict. */
export type EvaluationStatus = "active" | "terminal";

/**
 * Durable loop state (#96 hardening): where an idea's evaluation is, so a tick resumes after a
 * crash/restart instead of starting over. `failedAngles` and `currentIteration` are the resume cursor;
 * `costCents` is the accrued spend charged against tenant usage.
 */
export interface VentureEvaluation {
  id: string;
  workspaceId: string;
  ideaId: string;
  status: EvaluationStatus;
  terminalVerdict: Verdict | null;
  currentIteration: number;
  failedAngles: string[];
  lastScore: number | null;
  costCents: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One iteration's log entry — the loop's compact working memory + audit trail. */
export interface IterationLogEntry {
  id: string;
  workspaceId: string;
  ideaId: string;
  iteration: number;
  score: number;
  verdict: Verdict;
  gapList: GapList;
  /** The angles (rubric dimensions) this pass would pursue — drives the no-repeat check. */
  angles: string[];
  evidence: Evidence[];
  /** A one-line compact summary of the pass (loop-engineering working memory). */
  workingMemorySummary: string;
  createdAt: Date;
}
