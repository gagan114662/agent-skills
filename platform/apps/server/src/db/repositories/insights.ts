import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { insightSources, insights, insightEvidence } from "../schema/index.js";
import type {
  EvidenceRef,
  Insight,
  InsightInput,
  InsightSource,
  InsightStatus,
  SourceInput,
  SourceStatus,
} from "../../insight/types.js";

/**
 * Insight Miner repository (#100, ADR-0100). Workspace-scoped throughout (the #3 IDOR discipline);
 * the pure ranking/dedupe logic lives in `../../insight/*` — this is persistence only.
 */

// ---- sources (the ranked candidate list) ------------------------------------

const SOURCE_COLS = {
  id: insightSources.id,
  workspaceId: insightSources.workspaceId,
  kind: insightSources.kind,
  url: insightSources.url,
  title: insightSources.title,
  observedAt: insightSources.observedAt,
  evidenceStrength: insightSources.evidenceStrength,
  status: insightSources.status,
  createdByMemberId: insightSources.createdByMemberId,
  createdAt: insightSources.createdAt,
} as const;

export async function createSource(
  input: SourceInput & {
    workspaceId: string;
    evidenceStrength: number;
    createdByMemberId: string | null;
  },
): Promise<InsightSource> {
  const [row] = await db
    .insert(insightSources)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      url: input.url,
      title: input.title,
      observedAt: input.observedAt,
      evidenceStrength: input.evidenceStrength,
      createdByMemberId: input.createdByMemberId,
    })
    .returning(SOURCE_COLS);
  return row as InsightSource;
}

export async function getSource(
  workspaceId: string,
  id: string,
): Promise<InsightSource | undefined> {
  const [row] = await db
    .select(SOURCE_COLS)
    .from(insightSources)
    .where(and(eq(insightSources.id, id), eq(insightSources.workspaceId, workspaceId)))
    .limit(1);
  return row as InsightSource | undefined;
}

/** Every source for a workspace, strongest-evidence first — the "list is the strategy" ordering. */
export async function listSources(workspaceId: string): Promise<InsightSource[]> {
  const rows = await db
    .select(SOURCE_COLS)
    .from(insightSources)
    .where(eq(insightSources.workspaceId, workspaceId))
    .orderBy(desc(insightSources.evidenceStrength), desc(insightSources.createdAt));
  return rows as InsightSource[];
}

/** Still-`candidate` sources, strongest first — the miner's work-list. */
export async function listCandidateSources(workspaceId: string): Promise<InsightSource[]> {
  const rows = await db
    .select(SOURCE_COLS)
    .from(insightSources)
    .where(
      and(eq(insightSources.workspaceId, workspaceId), eq(insightSources.status, "candidate")),
    )
    .orderBy(desc(insightSources.evidenceStrength), desc(insightSources.createdAt));
  return rows as InsightSource[];
}

export async function setSourceStatus(
  workspaceId: string,
  id: string,
  status: SourceStatus,
): Promise<void> {
  await db
    .update(insightSources)
    .set({ status })
    .where(and(eq(insightSources.id, id), eq(insightSources.workspaceId, workspaceId)));
}

// ---- insights ---------------------------------------------------------------

const INSIGHT_COLS = {
  id: insights.id,
  workspaceId: insights.workspaceId,
  kind: insights.kind,
  statement: insights.statement,
  painIntensity: insights.painIntensity,
  competitionAbsence: insights.competitionAbsence,
  freshnessAt: insights.freshnessAt,
  score: insights.score,
  status: insights.status,
  dedupeKey: insights.dedupeKey,
  promotedIdeaId: insights.promotedIdeaId,
  sourceId: insights.sourceId,
  createdByMemberId: insights.createdByMemberId,
  createdAt: insights.createdAt,
} as const;

export async function createInsight(
  input: Omit<InsightInput, "evidence"> & {
    workspaceId: string;
    score: number;
    dedupeKey: string;
    createdByMemberId: string | null;
  },
): Promise<Insight> {
  const [row] = await db
    .insert(insights)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      statement: input.statement,
      painIntensity: input.painIntensity,
      competitionAbsence: input.competitionAbsence,
      freshnessAt: input.freshnessAt,
      score: input.score,
      dedupeKey: input.dedupeKey,
      sourceId: input.sourceId,
      createdByMemberId: input.createdByMemberId,
    })
    .returning(INSIGHT_COLS);
  return row as Insight;
}

export async function getInsight(
  workspaceId: string,
  id: string,
): Promise<Insight | undefined> {
  const [row] = await db
    .select(INSIGHT_COLS)
    .from(insights)
    .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
    .limit(1);
  return row as Insight | undefined;
}

/** Every insight for a workspace, highest-score first — the pipeline view. */
export async function listInsights(workspaceId: string): Promise<Insight[]> {
  const rows = await db
    .select(INSIGHT_COLS)
    .from(insights)
    .where(eq(insights.workspaceId, workspaceId))
    .orderBy(desc(insights.score), desc(insights.createdAt));
  return rows as Insight[];
}

export async function setInsightStatus(
  workspaceId: string,
  id: string,
  status: InsightStatus,
): Promise<void> {
  await db
    .update(insights)
    .set({ status })
    .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)));
}

/** Stamp the provenance link to the #96 venture idea + mark the insight promoted. */
export async function setInsightPromotion(
  workspaceId: string,
  id: string,
  promotedIdeaId: string,
): Promise<void> {
  await db
    .update(insights)
    .set({ promotedIdeaId, status: "promoted" })
    .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)));
}

// ---- evidence (the provenance trail) ----------------------------------------

const EVIDENCE_COLS = {
  sourceUrl: insightEvidence.sourceUrl,
  excerpt: insightEvidence.excerpt,
  observedAt: insightEvidence.observedAt,
  sourceId: insightEvidence.sourceId,
} as const;

export async function insertEvidence(
  workspaceId: string,
  insightId: string,
  rows: EvidenceRef[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(insightEvidence).values(
    rows.map((r) => ({
      workspaceId,
      insightId,
      sourceUrl: r.sourceUrl,
      excerpt: r.excerpt,
      observedAt: r.observedAt,
      sourceId: r.sourceId,
    })),
  );
}

export async function listEvidence(
  workspaceId: string,
  insightId: string,
): Promise<EvidenceRef[]> {
  const rows = await db
    .select(EVIDENCE_COLS)
    .from(insightEvidence)
    .where(
      and(eq(insightEvidence.workspaceId, workspaceId), eq(insightEvidence.insightId, insightId)),
    )
    .orderBy(asc(insightEvidence.createdAt));
  return rows as EvidenceRef[];
}

/** Distinct workspaces with a `candidate` source — the scheduled miner's work-list. */
export async function listCandidateSourceWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: insightSources.workspaceId })
    .from(insightSources)
    .where(eq(insightSources.status, "candidate"));
  return rows.map((r) => r.workspaceId);
}
