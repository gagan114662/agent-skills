/**
 * Typed artifacts for the Insight Miner (#100). The Miner turns real evidence sources into structured
 * insights that feed the Venture Loop (#96) SOURCE stage. Persisted via `db/repositories/insights.ts`;
 * the pure ranking/dedupe logic lives in `ranking.ts`/`dedupe.ts`.
 */

/** The asymmetry classes a candidate source can carry (mirrors the DB `insight_sources.kind` check). */
export type SourceKind =
  | "community"
  | "reviews"
  | "support_forum"
  | "api_changelog"
  | "regulation"
  | "pricing"
  | "model_capability"
  | "owner_secret";

export type SourceStatus = "candidate" | "mined" | "skipped";

/** The three insight kinds: cited pain, a why-now delta, or the owner's proprietary secret. */
export type InsightKind = "pain" | "why_now" | "owner_secret";

export type InsightStatus = "mined" | "promoted" | "killed" | "duplicate";

/** A candidate source the operator/miner registers; ranked by `evidenceStrength` before mining. */
export interface SourceInput {
  kind: SourceKind;
  url: string | null;
  title: string;
  /** Recency of the source (drives the freshness factor). */
  observedAt: Date;
}

export interface InsightSource extends SourceInput {
  id: string;
  workspaceId: string;
  /** The pure `rankSource` output stamped at insert — the "list is the strategy" ordering key. */
  evidenceStrength: number;
  status: SourceStatus;
  createdByMemberId: string | null;
  createdAt: Date;
}

/** One provenance row: a cited claim with a source URL + recency. */
export interface EvidenceRef {
  sourceUrl: string | null;
  excerpt: string;
  observedAt: Date;
  sourceId: string | null;
}

/** The structured insight a miner/owner produces, before it is scored + persisted. */
export interface InsightInput {
  kind: InsightKind;
  statement: string;
  /** Pain acuteness, 0–10 (a painkiller scores high, a vitamin low). */
  painIntensity: number;
  /** How uncontested the space is, 0–10 (10 = no credible incumbent). */
  competitionAbsence: number;
  /** Recency of the strongest supporting evidence (drives the freshness factor). */
  freshnessAt: Date;
  /** The provenance trail — source URLs + recency. Empty ⇒ the insight is uncited. */
  evidence: EvidenceRef[];
  /** The candidate source this insight was mined from, if any. */
  sourceId: string | null;
}

/** A persisted insight. */
export interface Insight {
  id: string;
  workspaceId: string;
  kind: InsightKind;
  statement: string;
  painIntensity: number;
  competitionAbsence: number;
  freshnessAt: Date;
  /** The pure `rankInsight` output stamped at insert. */
  score: number;
  status: InsightStatus;
  /** sha256 of the normalized statement (#15 memory key) — the killed-angle dedupe handle. */
  dedupeKey: string;
  /** The #96 venture idea this insight became, once promoted (the provenance link). */
  promotedIdeaId: string | null;
  sourceId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
}
