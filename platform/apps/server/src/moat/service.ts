import { scoreMoat, assessAccrualWindow } from "./score.js";
import { moatWeights, stagnationWindowMs, type MoatCaps } from "./caps.js";
import type { MoatAccrual, MoatLedgerEntry, VentureMoat } from "./types.js";

/**
 * The Moat Accrual IO orchestrator (#103, ADR-0103), modelled on the #96 VentureService: side effects
 * here, pure scoring/stagnation logic in `score.ts`. Every collaborator is an injected seam so the
 * service is unit-tested against a fake ledger (no DB); `default.ts` wires the real repo. **Read-mostly**:
 * the only mutation is recording an accrual; scoring + stagnation are pure projections of the ledger.
 */

/** Persistence surface the orchestrator needs (a subset of `db/repositories/moat.ts`). */
export interface MoatRepo {
  /** Append one accrual to the ledger. `createdAt` defaults to now in the DB (tests may pin it). */
  recordAccrual(
    input: MoatAccrual & {
      workspaceId: string;
      ventureIdeaId: string;
      createdByMemberId: string | null;
      createdAt?: Date;
    },
  ): Promise<MoatLedgerEntry>;
  /** Every accrual recorded for a venture, workspace-scoped (the #3 IDOR boundary). */
  listAccruals(workspaceId: string, ventureIdeaId: string): Promise<MoatLedgerEntry[]>;
}

export interface MoatServiceDeps {
  repo: MoatRepo;
  /** Per-workspace resolved moat policy (window + weights). */
  caps: (workspaceId: string) => MoatCaps;
  now?: () => Date;
}

export class MoatService {
  constructor(private readonly deps: MoatServiceDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Record one concrete accrual against a venture (the only mutation). */
  async record(
    workspaceId: string,
    ventureIdeaId: string,
    accrual: MoatAccrual,
    createdByMemberId: string | null,
  ): Promise<MoatLedgerEntry> {
    return this.deps.repo.recordAccrual({
      ...accrual,
      workspaceId,
      ventureIdeaId,
      createdByMemberId,
    });
  }

  /** Score one venture's moat + assess stagnation — the read surface #96/#107 consume. */
  async scoreVenture(workspaceId: string, ventureIdeaId: string): Promise<VentureMoat> {
    const caps = this.deps.caps(workspaceId);
    const entries = await this.deps.repo.listAccruals(workspaceId, ventureIdeaId);
    return this.assess(ventureIdeaId, entries, caps);
  }

  /** Score every supplied venture's moat (the portfolio surface the Founder Console + #107 read).
   * Ventures with no ledger rows still appear — scored 0 and flagged stagnant. */
  async portfolioMoat(workspaceId: string, ventureIdeaIds: string[]): Promise<VentureMoat[]> {
    const caps = this.deps.caps(workspaceId);
    const out: VentureMoat[] = [];
    for (const ideaId of ventureIdeaIds) {
      const entries = await this.deps.repo.listAccruals(workspaceId, ideaId);
      out.push(this.assess(ideaId, entries, caps));
    }
    return out;
  }

  /** Combine the pure score + window assessment for one venture's ledger entries. */
  private assess(
    ventureIdeaId: string,
    entries: MoatLedgerEntry[],
    caps: MoatCaps,
  ): VentureMoat {
    const scored = scoreMoat(entries, moatWeights(caps));
    const window = assessAccrualWindow({
      entries: entries.map((e) => ({ createdAtMs: e.createdAt.getTime() })),
      nowMs: this.now().getTime(),
      windowMs: stagnationWindowMs(caps),
    });
    return {
      ventureIdeaId,
      score: scored.score,
      dimensions: scored.dimensions,
      accrualsInWindow: window.accrualsInWindow,
      stagnant: window.stagnant,
      lastAccrualAtMs: window.lastAccrualAtMs,
    };
  }
}
