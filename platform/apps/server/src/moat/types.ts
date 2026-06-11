/**
 * Moat Accrual types (#103, ADR-0103). The typed surfaces of the moat subsystem — the four scored
 * dimensions, a concrete accrual, and the persisted ledger row. Pure scoring lives in `score.ts`;
 * the IO orchestrator in `service.ts`; persistence in `db/repositories/moat.ts`.
 */

import { MOAT_DIMENSIONS, type MoatDimension } from "./score.js";

export { MOAT_DIMENSIONS };
export type { MoatDimension };

/**
 * A concrete moat accrual — the unit the ledger records. `magnitude` (≥ 0) is the size of the accrual
 * in `unit` terms (rows, integrations, evals, …); `provenance` is where it came from (the pipeline /
 * attestation / network it was measured on); `sourceRef` is an optional pointer to the source artifact.
 */
export interface MoatAccrual {
  dimension: MoatDimension;
  magnitude: number;
  unit: string;
  description: string;
  provenance: string;
  sourceRef: string | null;
}

/** A persisted ledger row — one accrual, attributed to a venture and (optionally) a member. */
export interface MoatLedgerEntry extends MoatAccrual {
  id: string;
  workspaceId: string;
  ventureIdeaId: string;
  createdByMemberId: string | null;
  createdAt: Date;
}

/** Per-venture moat roll-up — the surface the Venture scorecard (#96), the portfolio tick (#107),
 * and the Founder Console (#104) consume. */
export interface VentureMoat {
  ventureIdeaId: string;
  /** 0–100 weighted-mean moat score. */
  score: number;
  /** Per-dimension 0–10 subscores. */
  dimensions: Record<MoatDimension, number>;
  /** Accruals recorded within the stagnation window. */
  accrualsInWindow: number;
  /** True when zero accrual landed in the window (the pivot/kill signal). */
  stagnant: boolean;
  /** Epoch ms of the most recent accrual, or null when the ledger is empty. */
  lastAccrualAtMs: number | null;
}
