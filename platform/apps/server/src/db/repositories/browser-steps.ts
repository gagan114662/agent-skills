import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { browserSteps } from "../schema/index.js";
import type { BrowserReceipt, BrowserReceiptRecorder } from "../../runtime/browser/receipts.js";
import type { BROWSER_STEP_DECISIONS, BROWSER_STEP_TOOLS } from "../schema/browser-steps.js";

/**
 * Agent browser receipts repository (#174, ADR-0174). Implements the {@link BrowserReceiptRecorder}
 * seam the session writes through — the production path that persists `browser_steps` rows (the
 * in-memory recorder is the test/default). Workspace-scoped throughout (the #3 IDOR discipline).
 */
export const dbBrowserReceiptRecorder: BrowserReceiptRecorder = {
  async record(receipt: BrowserReceipt): Promise<void> {
    await db.insert(browserSteps).values({
      workspaceId: receipt.workspaceId,
      sessionId: receipt.sessionId,
      stepNo: receipt.stepNo,
      tool: receipt.tool as (typeof BROWSER_STEP_TOOLS)[number],
      url: receipt.url,
      sideEffectful: receipt.sideEffectful,
      decision: receipt.decision as (typeof BROWSER_STEP_DECISIONS)[number],
      approvalRequestId: receipt.approvalRequestId,
      screenshotPath: receipt.screenshotPath,
      bytes: receipt.bytes,
      detail: receipt.detail,
    });
  },
};

/** One persisted receipt row (the read shape for the console's "why?" feed). */
export interface BrowserStepRow {
  id: string;
  sessionId: string;
  stepNo: number;
  tool: string;
  url: string | null;
  sideEffectful: boolean;
  decision: string;
  approvalRequestId: string | null;
  screenshotPath: string | null;
  bytes: number;
  detail: string;
  createdAtMs: number;
}

/** The receipt stream for one session, in step order (tenant-scoped) — the live "what the agent saw". */
export async function listBrowserSteps(
  workspaceId: string,
  sessionId: string,
  limit = 200,
): Promise<BrowserStepRow[]> {
  const rows = await db
    .select()
    .from(browserSteps)
    .where(and(eq(browserSteps.workspaceId, workspaceId), eq(browserSteps.sessionId, sessionId)))
    .orderBy(browserSteps.stepNo)
    .limit(limit);
  return rows.map(toRow);
}

/** Recent receipts across a workspace, newest first (read-only, tenant-scoped) — the console feed. */
export async function listRecentBrowserSteps(workspaceId: string, limit = 100): Promise<BrowserStepRow[]> {
  const rows = await db
    .select()
    .from(browserSteps)
    .where(eq(browserSteps.workspaceId, workspaceId))
    .orderBy(desc(browserSteps.createdAt))
    .limit(limit);
  return rows.map(toRow);
}

function toRow(r: typeof browserSteps.$inferSelect): BrowserStepRow {
  return {
    id: r.id,
    sessionId: r.sessionId,
    stepNo: r.stepNo,
    tool: r.tool,
    url: r.url,
    sideEffectful: r.sideEffectful,
    decision: r.decision,
    approvalRequestId: r.approvalRequestId,
    screenshotPath: r.screenshotPath,
    bytes: r.bytes,
    detail: r.detail,
    createdAtMs: r.createdAt.getTime(),
  };
}
