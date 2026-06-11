import { and, asc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { demandExperiments, demandSignals, demandRefunds } from "../schema/index.js";
import type {
  DemandExperiment,
  ExperimentStore,
  RecordSignalInput,
  RefundStore,
  SignalStore,
} from "../../demand/service.js";
import type { DemandSignal, ExternalSource } from "../../demand/provenance.js";

/**
 * Demand Validation Rails repository (#101, ADR-0101). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure provenance/funnel/experiment logic lives in `../../demand/*` — this is
 * persistence only. Implements the {@link ExperimentStore}/{@link SignalStore}/{@link RefundStore} seams
 * the `DemandValidationService` injects.
 */

const EXPERIMENT_COLS = {
  id: demandExperiments.id,
  workspaceId: demandExperiments.workspaceId,
  ventureIdeaId: demandExperiments.ventureIdeaId,
  hypothesis: demandExperiments.hypothesis,
  successClass: demandExperiments.successClass,
  denominatorClass: demandExperiments.denominatorClass,
  passThreshold: demandExperiments.passThreshold,
  minSample: demandExperiments.minSample,
  windowStartMs: demandExperiments.windowStartMs,
  windowEndMs: demandExperiments.windowEndMs,
  availability: demandExperiments.availability,
  disclosure: demandExperiments.disclosure,
  status: demandExperiments.status,
  landingUrl: demandExperiments.landingUrl,
  checkoutUrl: demandExperiments.checkoutUrl,
  createdByMemberId: demandExperiments.createdByMemberId,
  createdAt: demandExperiments.createdAt,
} as const;

export const dbExperimentStore: ExperimentStore = {
  async create(input) {
    const [row] = await db
      .insert(demandExperiments)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        ventureIdeaId: input.ventureIdeaId,
        hypothesis: input.hypothesis,
        successClass: input.successClass,
        denominatorClass: input.denominatorClass,
        passThreshold: input.passThreshold,
        minSample: input.minSample,
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        availability: input.availability,
        disclosure: input.disclosure,
        createdByMemberId: input.createdByMemberId,
      })
      .returning(EXPERIMENT_COLS);
    return row as DemandExperiment;
  },

  async get(workspaceId, id) {
    const [row] = await db
      .select(EXPERIMENT_COLS)
      .from(demandExperiments)
      .where(and(eq(demandExperiments.id, id), eq(demandExperiments.workspaceId, workspaceId)))
      .limit(1);
    return row as DemandExperiment | undefined;
  },

  async list(workspaceId, ventureIdeaId) {
    const where = ventureIdeaId
      ? and(eq(demandExperiments.workspaceId, workspaceId), eq(demandExperiments.ventureIdeaId, ventureIdeaId))
      : eq(demandExperiments.workspaceId, workspaceId);
    const rows = await db
      .select(EXPERIMENT_COLS)
      .from(demandExperiments)
      .where(where)
      .orderBy(asc(demandExperiments.createdAt));
    return rows as DemandExperiment[];
  },

  async markLive(workspaceId, id, landingUrl, checkoutUrl) {
    const [row] = await db
      .update(demandExperiments)
      .set({ status: "live", landingUrl, checkoutUrl })
      .where(and(eq(demandExperiments.id, id), eq(demandExperiments.workspaceId, workspaceId)))
      .returning(EXPERIMENT_COLS);
    return row as DemandExperiment;
  },
};

/** Reconstruct the typed signal — every persisted signal is externally attributed by construction. */
function toSignal(row: {
  signalClass: DemandSignal["signalClass"];
  source: string;
  externalRef: string;
  amountCents: number;
  currency: string;
}): DemandSignal {
  return {
    signalClass: row.signalClass,
    provenance: {
      kind: "externally_attributed",
      attribution: { source: row.source as ExternalSource, externalRef: row.externalRef },
    },
    amountCents: row.amountCents,
    currency: row.currency,
  };
}

const SIGNAL_COLS = {
  signalClass: demandSignals.signalClass,
  source: demandSignals.source,
  externalRef: demandSignals.externalRef,
  amountCents: demandSignals.amountCents,
  currency: demandSignals.currency,
} as const;

export const dbSignalStore: SignalStore = {
  async record(input: RecordSignalInput) {
    const inserted = await db
      .insert(demandSignals)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        experimentId: input.experimentId,
        ventureIdeaId: input.ventureIdeaId,
        signalClass: input.signalClass,
        source: input.source,
        externalRef: input.externalRef,
        amountCents: input.amountCents,
        currency: input.currency,
      })
      // Idempotent on (workspace, experiment, external ref): a replay inserts nothing.
      .onConflictDoNothing({
        target: [demandSignals.workspaceId, demandSignals.experimentId, demandSignals.externalRef],
      })
      .returning({ id: demandSignals.id });
    return { deduped: inserted.length === 0 };
  },

  async list(workspaceId, experimentId) {
    const rows = await db
      .select(SIGNAL_COLS)
      .from(demandSignals)
      .where(and(eq(demandSignals.workspaceId, workspaceId), eq(demandSignals.experimentId, experimentId)));
    return rows.map(toSignal);
  },

  async listForIdea(workspaceId, ventureIdeaId) {
    const rows = await db
      .select(SIGNAL_COLS)
      .from(demandSignals)
      .where(and(eq(demandSignals.workspaceId, workspaceId), eq(demandSignals.ventureIdeaId, ventureIdeaId)));
    return rows.map(toSignal);
  },
};

export const dbRefundStore: RefundStore = {
  async record(input) {
    await db.insert(demandRefunds).values({
      id: newId(),
      workspaceId: input.workspaceId,
      experimentId: input.experimentId,
      externalRef: input.externalRef,
      amountCents: input.amountCents,
      currency: input.currency,
      reason: input.reason,
    });
  },
};
