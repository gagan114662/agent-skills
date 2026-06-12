import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "../index.js";
import { buildLoopRuns, buildLoopReviews } from "../schema/index.js";
import type { RunStore, ReviewStore } from "../../build-loop/engine.js";
import type { BuildRunRecord } from "../../build-loop/types.js";

/**
 * Durable stores for the Self-Shipping Loop (#172, ADR-0172). Implement the {@link RunStore} and
 * {@link ReviewStore} engine seams over `build_loop_runs` / `build_loop_reviews`. Every query filters
 * `workspace_id` (the #3 tenant boundary). The "one run per issue" contract is the table's UNIQUE
 * constraint; `upsertQueued` reads/writes through it (insert-or-return).
 */

/** Runs in these statuses are terminal — excluded from the tick work-list + the active listing. */
const TERMINAL_STATUSES = ["merged", "escalated", "failed"] as const;

const RUN_COLUMNS = {
  id: buildLoopRuns.id,
  workspaceId: buildLoopRuns.workspaceId,
  issueRef: buildLoopRuns.issueRef,
  issueTitle: buildLoopRuns.issueTitle,
  priority: buildLoopRuns.priority,
  dependsOn: buildLoopRuns.dependsOn,
  agentOk: buildLoopRuns.agentOk,
  status: buildLoopRuns.status,
  reviewRounds: buildLoopRuns.reviewRounds,
  buildSessionId: buildLoopRuns.buildSessionId,
  prRef: buildLoopRuns.prRef,
  prHeadBranch: buildLoopRuns.prHeadBranch,
  mergeRef: buildLoopRuns.mergeRef,
  escalationReason: buildLoopRuns.escalationReason,
  targetChannelId: buildLoopRuns.targetChannelId,
  targetAgentMemberId: buildLoopRuns.targetAgentMemberId,
  createdAt: buildLoopRuns.createdAt,
  updatedAt: buildLoopRuns.updatedAt,
} as const;

async function selectRun(
  workspaceId: string,
  by: { id?: string; issueRef?: string },
): Promise<BuildRunRecord | null> {
  const cond = by.id
    ? and(eq(buildLoopRuns.workspaceId, workspaceId), eq(buildLoopRuns.id, by.id))
    : and(eq(buildLoopRuns.workspaceId, workspaceId), eq(buildLoopRuns.issueRef, by.issueRef ?? ""));
  const [row] = await db.select(RUN_COLUMNS).from(buildLoopRuns).where(cond).limit(1);
  return (row as BuildRunRecord | undefined) ?? null;
}

export const buildLoopRunStore: RunStore = {
  async upsertQueued(input) {
    // Insert-or-return: the UNIQUE(workspace_id, issue_ref) makes "one run per issue" a DB invariant.
    const inserted = await db
      .insert(buildLoopRuns)
      .values({
        workspaceId: input.workspaceId,
        issueRef: input.issueRef,
        issueTitle: input.issueTitle,
        priority: input.priority,
        dependsOn: input.dependsOn,
        agentOk: input.agentOk,
        status: "queued",
        reviewRounds: 0,
        targetChannelId: input.targetChannelId,
        targetAgentMemberId: input.targetAgentMemberId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [buildLoopRuns.workspaceId, buildLoopRuns.issueRef] })
      .returning(RUN_COLUMNS);
    if (inserted[0]) return inserted[0] as BuildRunRecord;
    const existing = await selectRun(input.workspaceId, { issueRef: input.issueRef });
    if (!existing) throw new Error("build-loop: upsertQueued failed to insert or find the run");
    return existing;
  },

  async get(workspaceId, id) {
    return selectRun(workspaceId, { id });
  },

  async getByIssueRef(workspaceId, issueRef) {
    return selectRun(workspaceId, { issueRef });
  },

  async listActive(workspaceId) {
    const rows = await db
      .select(RUN_COLUMNS)
      .from(buildLoopRuns)
      .where(
        and(
          eq(buildLoopRuns.workspaceId, workspaceId),
          notInArray(buildLoopRuns.status, [...TERMINAL_STATUSES]),
        ),
      );
    return rows as BuildRunRecord[];
  },

  async listMergedRefs(workspaceId) {
    const rows = await db
      .select({ issueRef: buildLoopRuns.issueRef })
      .from(buildLoopRuns)
      .where(and(eq(buildLoopRuns.workspaceId, workspaceId), eq(buildLoopRuns.status, "merged")));
    return rows.map((r) => r.issueRef);
  },

  async update(input) {
    const [row] = await db
      .update(buildLoopRuns)
      .set({ ...input.patch, updatedAt: input.now })
      .where(eq(buildLoopRuns.id, input.id))
      .returning(RUN_COLUMNS);
    if (!row) throw new Error("build-loop: update of a missing run");
    return row as BuildRunRecord;
  },

  async listForConsole(workspaceId) {
    const rows = await db
      .select(RUN_COLUMNS)
      .from(buildLoopRuns)
      .where(eq(buildLoopRuns.workspaceId, workspaceId))
      .orderBy(desc(buildLoopRuns.updatedAt))
      .limit(50);
    return rows as BuildRunRecord[];
  },
};

export const buildLoopReviewStore: ReviewStore = {
  async create(input) {
    await db.insert(buildLoopReviews).values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      round: input.round,
      verdict: input.verdict,
      summary: input.summary,
      findings: input.findings,
      reviewerSessionId: input.reviewerSessionId,
      createdAt: input.now,
    });
  },

  async listForConsole(workspaceId) {
    const rows = await db
      .select({
        runId: buildLoopReviews.runId,
        round: buildLoopReviews.round,
        verdict: buildLoopReviews.verdict,
        summary: buildLoopReviews.summary,
        createdAt: buildLoopReviews.createdAt,
      })
      .from(buildLoopReviews)
      .where(eq(buildLoopReviews.workspaceId, workspaceId))
      .orderBy(desc(buildLoopReviews.createdAt))
      .limit(50);
    return rows as Array<{
      runId: string;
      round: number;
      verdict: "pass" | "fail";
      summary: string;
      createdAt: Date;
    }>;
  },
};

/** Workspaces with at least one non-terminal run — the self-shipping-loop tick work-list. */
export async function listActiveBuildLoopWorkspaces(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: buildLoopRuns.workspaceId })
    .from(buildLoopRuns)
    .where(notInArray(buildLoopRuns.status, [...TERMINAL_STATUSES]));
  return rows.map((r) => r.workspaceId);
}

/** Recent runs in a set of statuses (used by callers that want only the queue or only merged history). */
export async function listRunsByStatus(
  workspaceId: string,
  statuses: BuildRunRecord["status"][],
): Promise<BuildRunRecord[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select(RUN_COLUMNS)
    .from(buildLoopRuns)
    .where(and(eq(buildLoopRuns.workspaceId, workspaceId), inArray(buildLoopRuns.status, statuses)))
    .orderBy(desc(buildLoopRuns.updatedAt));
  return rows as BuildRunRecord[];
}
