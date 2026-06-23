import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../index.js";
import {
  discoveryPipelineEntries,
  discoveryProspectOutcomes,
  discoveryPqlEvents,
  discoverySignalDefs,
  discoverySignals,
} from "../schema/index.js";
import type {
  PipelineStore,
  OutcomeStore,
  PqlStore,
  SignalDefStore,
  SignalStore,
} from "../../discovery/service.js";
import { emittedKey } from "../../discovery/score.js";
import type {
  DiscoverySignalRecord,
  PipelineEntryRecord,
  ProspectOutcomeRecord,
  PqlEventRecord,
  SignalDefRecord,
} from "../../discovery/types.js";

/**
 * Customer Discovery Engine repository (#222, ADR-0222). Workspace-scoped throughout (the #3 IDOR
 * discipline); the pure rank/qualify/pipeline logic lives in `discovery/score.ts` — this is persistence
 * only. Each store implements the seam interface declared in `discovery/service.ts`.
 */

const SIGNAL_COLS = {
  id: discoverySignals.id,
  workspaceId: discoverySignals.workspaceId,
  ideaId: discoverySignals.ideaId,
  prospectKey: discoverySignals.prospectKey,
  kind: discoverySignals.kind,
  value: discoverySignals.value,
  role: discoverySignals.role,
  source: discoverySignals.source,
  externalRef: discoverySignals.externalRef,
  occurredAt: discoverySignals.occurredAt,
  detail: discoverySignals.detail,
  createdAt: discoverySignals.createdAt,
} as const;

const DEF_COLS = {
  id: discoverySignalDefs.id,
  workspaceId: discoverySignalDefs.workspaceId,
  ideaId: discoverySignalDefs.ideaId,
  kind: discoverySignalDefs.kind,
  label: discoverySignalDefs.label,
  threshold: discoverySignalDefs.threshold,
  windowDays: discoverySignalDefs.windowDays,
  role: discoverySignalDefs.role,
  weight: discoverySignalDefs.weight,
  enabled: discoverySignalDefs.enabled,
  createdByMemberId: discoverySignalDefs.createdByMemberId,
  createdAt: discoverySignalDefs.createdAt,
  updatedAt: discoverySignalDefs.updatedAt,
} as const;

const PQL_COLS = {
  id: discoveryPqlEvents.id,
  workspaceId: discoveryPqlEvents.workspaceId,
  ideaId: discoveryPqlEvents.ideaId,
  prospectKey: discoveryPqlEvents.prospectKey,
  defId: discoveryPqlEvents.defId,
  defKind: discoveryPqlEvents.defKind,
  score: discoveryPqlEvents.score,
  verified: discoveryPqlEvents.verified,
  qualifyingSignals: discoveryPqlEvents.qualifyingSignals,
  occurredAt: discoveryPqlEvents.occurredAt,
  createdAt: discoveryPqlEvents.createdAt,
} as const;

const PIPELINE_COLS = {
  id: discoveryPipelineEntries.id,
  workspaceId: discoveryPipelineEntries.workspaceId,
  ideaId: discoveryPipelineEntries.ideaId,
  prospectKey: discoveryPipelineEntries.prospectKey,
  stage: discoveryPipelineEntries.stage,
  verified: discoveryPipelineEntries.verified,
  externalRef: discoveryPipelineEntries.externalRef,
  enteredAt: discoveryPipelineEntries.enteredAt,
  createdAt: discoveryPipelineEntries.createdAt,
} as const;

const OUTCOME_COLS = {
  id: discoveryProspectOutcomes.id,
  workspaceId: discoveryProspectOutcomes.workspaceId,
  ideaId: discoveryProspectOutcomes.ideaId,
  prospectKey: discoveryProspectOutcomes.prospectKey,
  outcome: discoveryProspectOutcomes.outcome,
  reason: discoveryProspectOutcomes.reason,
  source: discoveryProspectOutcomes.source,
  externalRef: discoveryProspectOutcomes.externalRef,
  closedAt: discoveryProspectOutcomes.closedAt,
  detail: discoveryProspectOutcomes.detail,
  createdAt: discoveryProspectOutcomes.createdAt,
  updatedAt: discoveryProspectOutcomes.updatedAt,
} as const;

export const dbSignalStore: SignalStore = {
  async insert(input) {
    const [row] = await db
      .insert(discoverySignals)
      .values({
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        prospectKey: input.prospectKey,
        kind: input.kind,
        value: input.value,
        role: input.role,
        source: input.source,
        externalRef: input.externalRef,
        occurredAt: input.occurredAt,
        detail: input.detail,
      })
      .returning(SIGNAL_COLS);
    return toSignal(row!);
  },
  async listForProspect(workspaceId, prospectKey, ideaId) {
    const conds = [
      eq(discoverySignals.workspaceId, workspaceId),
      eq(discoverySignals.prospectKey, prospectKey),
    ];
    if (ideaId !== undefined && ideaId !== null) {
      conds.push(eq(discoverySignals.ideaId, ideaId));
    }
    const rows = await db
      .select(SIGNAL_COLS)
      .from(discoverySignals)
      .where(and(...conds))
      .orderBy(desc(discoverySignals.occurredAt));
    return rows.map(toSignal);
  },
  async list(workspaceId, ideaId) {
    const where =
      ideaId === undefined
        ? eq(discoverySignals.workspaceId, workspaceId)
        : and(eq(discoverySignals.workspaceId, workspaceId), eq(discoverySignals.ideaId, ideaId));
    const rows = await db
      .select(SIGNAL_COLS)
      .from(discoverySignals)
      .where(where)
      .orderBy(desc(discoverySignals.occurredAt));
    return rows.map(toSignal);
  },
};

export const dbSignalDefStore: SignalDefStore = {
  async upsert(input) {
    // Manual upsert keyed on (workspace, idea, label): Postgres treats NULL idea_id as distinct, so a
    // partial-unique conflict target would not catch workspace-level (null-idea) re-definitions — find
    // the existing row first, then update it, else insert.
    const existing = await db
      .select({ id: discoverySignalDefs.id })
      .from(discoverySignalDefs)
      .where(
        and(
          eq(discoverySignalDefs.workspaceId, input.workspaceId),
          input.ideaId === null
            ? isNull(discoverySignalDefs.ideaId)
            : eq(discoverySignalDefs.ideaId, input.ideaId),
          eq(discoverySignalDefs.label, input.label),
        ),
      )
      .limit(1);
    if (existing[0]) {
      const [row] = await db
        .update(discoverySignalDefs)
        .set({
          kind: input.kind,
          threshold: input.threshold,
          windowDays: input.windowDays,
          role: input.role,
          weight: input.weight,
          enabled: input.enabled,
          updatedAt: new Date(),
        })
        .where(eq(discoverySignalDefs.id, existing[0].id))
        .returning(DEF_COLS);
      return toDef(row!);
    }
    const [row] = await db
      .insert(discoverySignalDefs)
      .values({
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        kind: input.kind,
        label: input.label,
        threshold: input.threshold,
        windowDays: input.windowDays,
        role: input.role,
        weight: input.weight,
        enabled: input.enabled,
        createdByMemberId: input.createdByMemberId,
      })
      .returning(DEF_COLS);
    return toDef(row!);
  },
  async list(workspaceId) {
    const rows = await db
      .select(DEF_COLS)
      .from(discoverySignalDefs)
      .where(eq(discoverySignalDefs.workspaceId, workspaceId))
      .orderBy(desc(discoverySignalDefs.createdAt));
    return rows.map(toDef);
  },
};

export const dbPqlStore: PqlStore = {
  async emittedKeys(workspaceId) {
    const rows = await db
      .select({
        prospectKey: discoveryPqlEvents.prospectKey,
        defId: discoveryPqlEvents.defId,
      })
      .from(discoveryPqlEvents)
      .where(eq(discoveryPqlEvents.workspaceId, workspaceId));
    // Build the idempotency set through the SAME `emittedKey` the detector uses (they must agree).
    return new Set(rows.map((r) => emittedKey(r.prospectKey, r.defId ?? "")));
  },
  async insert(input) {
    const [row] = await db
      .insert(discoveryPqlEvents)
      .values({
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        prospectKey: input.prospectKey,
        defId: input.defId,
        defKind: input.defKind,
        score: input.score,
        verified: input.verified,
        qualifyingSignals: input.qualifyingSignals,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({
        target: [
          discoveryPqlEvents.workspaceId,
          discoveryPqlEvents.prospectKey,
          discoveryPqlEvents.defId,
        ],
      })
      .returning(PQL_COLS);
    // On a (rare) idempotent re-fire the insert is a no-op; read the existing row back so callers always
    // get the canonical record.
    if (row) return toPql(row);
    const [existing] = await db
      .select(PQL_COLS)
      .from(discoveryPqlEvents)
      .where(
        and(
          eq(discoveryPqlEvents.workspaceId, input.workspaceId),
          eq(discoveryPqlEvents.prospectKey, input.prospectKey),
          input.defId === null
            ? isNull(discoveryPqlEvents.defId)
            : eq(discoveryPqlEvents.defId, input.defId),
        ),
      )
      .limit(1);
    return toPql(existing!);
  },
  async list(workspaceId, ideaId) {
    const where =
      ideaId === undefined
        ? eq(discoveryPqlEvents.workspaceId, workspaceId)
        : and(eq(discoveryPqlEvents.workspaceId, workspaceId), eq(discoveryPqlEvents.ideaId, ideaId));
    const rows = await db
      .select(PQL_COLS)
      .from(discoveryPqlEvents)
      .where(where)
      .orderBy(desc(discoveryPqlEvents.occurredAt));
    return rows.map(toPql);
  },
};

export const dbPipelineStore: PipelineStore = {
  async enter(input) {
    await db
      .insert(discoveryPipelineEntries)
      .values({
        workspaceId: input.workspaceId,
        ideaId: input.ideaId,
        prospectKey: input.prospectKey,
        stage: input.stage,
        verified: input.verified,
        externalRef: input.externalRef,
        enteredAt: input.enteredAt,
      })
      .onConflictDoNothing({
        target: [
          discoveryPipelineEntries.workspaceId,
          discoveryPipelineEntries.prospectKey,
          discoveryPipelineEntries.stage,
        ],
      });
  },
  async list(workspaceId, ideaId) {
    const where =
      ideaId === undefined
        ? eq(discoveryPipelineEntries.workspaceId, workspaceId)
        : and(
            eq(discoveryPipelineEntries.workspaceId, workspaceId),
            eq(discoveryPipelineEntries.ideaId, ideaId),
          );
    const rows = await db
      .select(PIPELINE_COLS)
      .from(discoveryPipelineEntries)
      .where(where)
      .orderBy(desc(discoveryPipelineEntries.enteredAt));
    return rows.map(toPipeline);
  },
};

export const dbOutcomeStore: OutcomeStore = {
  async upsert(input) {
    const [existing] = await db
      .select({ id: discoveryProspectOutcomes.id })
      .from(discoveryProspectOutcomes)
      .where(
        and(
          eq(discoveryProspectOutcomes.workspaceId, input.workspaceId),
          input.ideaId === null
            ? isNull(discoveryProspectOutcomes.ideaId)
            : eq(discoveryProspectOutcomes.ideaId, input.ideaId),
          eq(discoveryProspectOutcomes.prospectKey, input.prospectKey),
        ),
      )
      .limit(1);
    if (existing) {
      const [row] = await db
        .update(discoveryProspectOutcomes)
        .set({
          outcome: input.outcome,
          reason: input.reason,
          source: input.source,
          externalRef: input.externalRef,
          closedAt: input.closedAt,
          detail: input.detail,
          updatedAt: new Date(),
        })
        .where(eq(discoveryProspectOutcomes.id, existing.id))
        .returning(OUTCOME_COLS);
      return toOutcome(row!);
    }
    const [row] = await db
      .insert(discoveryProspectOutcomes)
      .values(input)
      .returning(OUTCOME_COLS);
    return toOutcome(row!);
  },
  async list(workspaceId, ideaId) {
    const where =
      ideaId === undefined
        ? eq(discoveryProspectOutcomes.workspaceId, workspaceId)
        : and(
            eq(discoveryProspectOutcomes.workspaceId, workspaceId),
            ideaId === null
              ? isNull(discoveryProspectOutcomes.ideaId)
              : eq(discoveryProspectOutcomes.ideaId, ideaId),
          );
    const rows = await db
      .select(OUTCOME_COLS)
      .from(discoveryProspectOutcomes)
      .where(where)
      .orderBy(desc(discoveryProspectOutcomes.closedAt));
    return rows.map(toOutcome);
  },
};

function toSignal(row: Record<string, unknown>): DiscoverySignalRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    prospectKey: row.prospectKey as string,
    kind: row.kind as DiscoverySignalRecord["kind"],
    value: row.value as number,
    role: (row.role as string | null) ?? null,
    source: row.source as string,
    externalRef: (row.externalRef as string | null) ?? null,
    occurredAt: row.occurredAt as Date,
    detail: (row.detail as Record<string, unknown>) ?? {},
    createdAt: row.createdAt as Date,
  };
}

function toDef(row: Record<string, unknown>): SignalDefRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    kind: row.kind as SignalDefRecord["kind"],
    label: row.label as string,
    threshold: row.threshold as number,
    windowDays: row.windowDays as number,
    role: (row.role as string | null) ?? null,
    weight: row.weight as number,
    enabled: row.enabled as boolean,
    createdByMemberId: (row.createdByMemberId as string | null) ?? null,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

function toPql(row: Record<string, unknown>): PqlEventRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    prospectKey: row.prospectKey as string,
    defId: (row.defId as string | null) ?? null,
    defKind: row.defKind as string,
    score: row.score as number,
    verified: row.verified as boolean,
    qualifyingSignals: (row.qualifyingSignals as string[]) ?? [],
    occurredAt: row.occurredAt as Date,
    createdAt: row.createdAt as Date,
  };
}

function toPipeline(row: Record<string, unknown>): PipelineEntryRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    prospectKey: row.prospectKey as string,
    stage: row.stage as PipelineEntryRecord["stage"],
    verified: row.verified as boolean,
    externalRef: (row.externalRef as string | null) ?? null,
    enteredAt: row.enteredAt as Date,
    createdAt: row.createdAt as Date,
  };
}

function toOutcome(row: Record<string, unknown>): ProspectOutcomeRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    ideaId: (row.ideaId as string | null) ?? null,
    prospectKey: row.prospectKey as string,
    outcome: row.outcome as ProspectOutcomeRecord["outcome"],
    reason: row.reason as string,
    source: row.source as string,
    externalRef: (row.externalRef as string | null) ?? null,
    closedAt: row.closedAt as Date,
    detail: (row.detail as Record<string, unknown>) ?? {},
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}
