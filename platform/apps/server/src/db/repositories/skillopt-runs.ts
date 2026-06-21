import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  skilloptRuns,
  skilloptProposals,
  type SkillOptProposalStatus,
} from "../schema/index.js";

/**
 * SkillOpt-Sleep run persistence repository (#283, ADR-0283). The durable side of the offline
 * self-improvement loop: it records each nightly run + one row per agent outcome (the measurable BEFORE/AFTER
 * validation signal), answers the idempotency question ("have we already proposed this exact edit?"), and
 * reads back the ledger for the console / tests. Workspace-scoped throughout (#3). Holds no money, no secret:
 * a row records that a proposal was STAGED for the owner, never that one was adopted — adoption stays
 * human-gated in the #13 queue. The loop sanitizes every text field before it reaches here (#200 §6).
 */

/** One agent outcome to persist — the canonical persistence contract (the service builds exactly this). */
export interface SkillOptOutcomeRecord {
  agentHandle: string;
  skillId: string;
  status: SkillOptProposalStatus;
  /** Why no proposal was staged (skipped/deduped only; null when staged). */
  skipReason: string | null;
  clusterKey: string | null;
  metric: string | null;
  higherIsBetter: boolean | null;
  /** BEFORE: metric under the current skill doc. */
  baseline: number | null;
  /** AFTER: metric under the proposed skill doc. */
  candidate: number | null;
  /** Measured relative improvement over baseline (null when not finitely computable, e.g. zero baseline). */
  improvementRatio: number | null;
  sampleSize: number | null;
  externallyVerified: boolean | null;
  currentDocSha: string | null;
  /** The #13 request id if a proposal was staged; null otherwise. */
  requestId: string | null;
}

export interface RecordSkillOptRunInput {
  workspaceId: string;
  enabled: boolean;
  outcomes: SkillOptOutcomeRecord[];
}

/** A persisted before/after signal row (read back for the console / measurement). */
export interface SkillOptProposalRow {
  id: string;
  runId: string;
  workspaceId: string;
  agentHandle: string;
  skillId: string;
  status: SkillOptProposalStatus;
  skipReason: string | null;
  clusterKey: string | null;
  metric: string | null;
  higherIsBetter: boolean | null;
  baseline: number | null;
  candidate: number | null;
  improvementRatio: number | null;
  sampleSize: number | null;
  externallyVerified: boolean | null;
  currentDocSha: string | null;
  requestId: string | null;
  createdAtMs: number;
}

/** Postgres `double precision` accepts ±Infinity, but the ledger keeps only finite numbers (null otherwise). */
function finiteOrNull(n: number | null): number | null {
  return n !== null && Number.isFinite(n) ? n : null;
}

/**
 * Persist one run + its per-agent outcomes atomically (ADR-0013 §7 style). Derives the run header counts
 * from the outcomes so the header and rows can never disagree. Returns the new run id.
 */
export async function recordSkillOptRun(input: RecordSkillOptRunInput): Promise<{ runId: string }> {
  const staged = input.outcomes.filter((o) => o.status === "staged").length;
  const deduped = input.outcomes.filter((o) => o.status === "deduped").length;
  const skipped = input.outcomes.filter((o) => o.status === "skipped").length;

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(skilloptRuns)
      .values({
        workspaceId: input.workspaceId,
        enabled: input.enabled,
        agentsProcessed: input.outcomes.length,
        stagedCount: staged,
        dedupedCount: deduped,
        skippedCount: skipped,
      })
      .returning({ id: skilloptRuns.id });
    const runId = run?.id ?? "";

    if (input.outcomes.length > 0) {
      await tx.insert(skilloptProposals).values(
        input.outcomes.map((o) => ({
          runId,
          workspaceId: input.workspaceId,
          agentHandle: o.agentHandle,
          skillId: o.skillId,
          status: o.status,
          skipReason: o.skipReason,
          clusterKey: o.clusterKey,
          metric: o.metric,
          higherIsBetter: o.higherIsBetter,
          baseline: finiteOrNull(o.baseline),
          candidate: finiteOrNull(o.candidate),
          improvementRatio: finiteOrNull(o.improvementRatio),
          sampleSize: o.sampleSize,
          externallyVerified: o.externallyVerified,
          currentDocSha: o.currentDocSha,
          requestId: o.requestId,
        })),
      );
    }
    return { runId };
  });
}

/**
 * Idempotency guard: has this exact edit (agent + mined cluster + the doc sha it was validated against)
 * already been STAGED for this workspace? When true, the loop must not re-stage it — a proposal is already
 * parked in the #13 queue (or was, against this unchanged doc), so re-proposing nightly would just spam the
 * owner. Once the doc changes (the owner adopts an edit, or edits it by hand) the sha differs and a fresh
 * proposal flows. Workspace-scoped (#3).
 */
export async function alreadyProposed(
  workspaceId: string,
  agentHandle: string,
  clusterKey: string,
  currentDocSha: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: skilloptProposals.id })
    .from(skilloptProposals)
    .where(
      and(
        eq(skilloptProposals.workspaceId, workspaceId),
        eq(skilloptProposals.agentHandle, agentHandle),
        eq(skilloptProposals.clusterKey, clusterKey),
        eq(skilloptProposals.currentDocSha, currentDocSha),
        eq(skilloptProposals.status, "staged"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** List a workspace's proposal ledger, newest first (for the console / audit). Capped. */
export async function listSkillOptProposals(
  workspaceId: string,
  opts: { status?: SkillOptProposalStatus; limit?: number } = {},
): Promise<SkillOptProposalRow[]> {
  const conds = [eq(skilloptProposals.workspaceId, workspaceId)];
  if (opts.status) conds.push(eq(skilloptProposals.status, opts.status));
  const rows = await db
    .select()
    .from(skilloptProposals)
    .where(and(...conds))
    .orderBy(desc(skilloptProposals.createdAt))
    .limit(opts.limit ?? 200);
  return rows.map(toRow);
}

/**
 * The most recent STAGED before/after signal for one agent — the headline "is this agent getting better?"
 * measurement (baseline → candidate, with the relative improvement). Null when the agent has never staged a
 * proposal. Workspace-scoped (#3).
 */
export async function latestImprovementSignal(
  workspaceId: string,
  agentHandle: string,
): Promise<SkillOptProposalRow | null> {
  const [row] = await db
    .select()
    .from(skilloptProposals)
    .where(
      and(
        eq(skilloptProposals.workspaceId, workspaceId),
        eq(skilloptProposals.agentHandle, agentHandle),
        eq(skilloptProposals.status, "staged"),
      ),
    )
    .orderBy(desc(skilloptProposals.createdAt))
    .limit(1);
  return row ? toRow(row) : null;
}

type ProposalSelect = typeof skilloptProposals.$inferSelect;

function toRow(r: ProposalSelect): SkillOptProposalRow {
  return {
    id: r.id,
    runId: r.runId,
    workspaceId: r.workspaceId,
    agentHandle: r.agentHandle,
    skillId: r.skillId,
    status: r.status,
    skipReason: r.skipReason,
    clusterKey: r.clusterKey,
    metric: r.metric,
    higherIsBetter: r.higherIsBetter,
    baseline: r.baseline,
    candidate: r.candidate,
    improvementRatio: r.improvementRatio,
    sampleSize: r.sampleSize,
    externallyVerified: r.externallyVerified,
    currentDocSha: r.currentDocSha,
    requestId: r.requestId,
    createdAtMs: r.createdAt.getTime(),
  };
}
