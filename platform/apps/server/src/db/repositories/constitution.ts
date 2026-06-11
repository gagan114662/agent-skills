import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { constitutionViolations } from "../schema/index.js";
import type {
  ConstitutionViolation,
  DecisionStage,
  ViolationSeverity,
} from "../../constitution/types.js";

/**
 * Constitution-violation repository (#146, ADR-0146). Workspace-scoped throughout (the #3 IDOR
 * discipline). Writes the durable flag feed; the Founder Console reads the `open` rows. Pure decision
 * logic lives in `../../constitution/*` — this is persistence only.
 */

/** One persisted violation row (the read shape). */
export interface ViolationRow {
  id: string;
  ideaId: string;
  article: string;
  code: string;
  severity: ViolationSeverity;
  stage: DecisionStage;
  verdict: string;
  message: string;
  status: "open" | "acknowledged";
  createdAtMs: number;
}

export async function recordViolation(input: {
  workspaceId: string;
  ideaId: string;
  /** The verdict under consideration, or the stage name at SOURCE. */
  verdict: string;
  violation: ConstitutionViolation;
}): Promise<{ id: string }> {
  const { workspaceId, ideaId, verdict, violation } = input;
  const [row] = await db
    .insert(constitutionViolations)
    .values({
      workspaceId,
      ideaId,
      article: violation.article,
      code: violation.code,
      severity: violation.severity,
      stage: violation.stage,
      verdict,
      message: violation.message,
    })
    .returning({ id: constitutionViolations.id });
  return { id: row!.id };
}

/** List the open (un-acknowledged) violations for a workspace, newest first. */
export async function listOpenViolations(workspaceId: string): Promise<ViolationRow[]> {
  const rows = await db
    .select({
      id: constitutionViolations.id,
      ideaId: constitutionViolations.ideaId,
      article: constitutionViolations.article,
      code: constitutionViolations.code,
      severity: constitutionViolations.severity,
      stage: constitutionViolations.stage,
      verdict: constitutionViolations.verdict,
      message: constitutionViolations.message,
      status: constitutionViolations.status,
      createdAt: constitutionViolations.createdAt,
    })
    .from(constitutionViolations)
    .where(
      and(
        eq(constitutionViolations.workspaceId, workspaceId),
        eq(constitutionViolations.status, "open"),
      ),
    )
    .orderBy(desc(constitutionViolations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    ideaId: r.ideaId,
    article: r.article,
    code: r.code,
    severity: r.severity as ViolationSeverity,
    stage: r.stage as DecisionStage,
    verdict: r.verdict,
    message: r.message,
    status: r.status as "open" | "acknowledged",
    createdAtMs: r.createdAt.getTime(),
  }));
}

/** Count the open violations for a workspace (the Founder Console attention reason). */
export async function countOpenViolations(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(constitutionViolations)
    .where(
      and(
        eq(constitutionViolations.workspaceId, workspaceId),
        eq(constitutionViolations.status, "open"),
      ),
    );
  return row?.n ?? 0;
}
