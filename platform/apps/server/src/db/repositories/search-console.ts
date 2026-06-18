import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../index.js";
import { searchConsoleSubmissions } from "../schema/index.js";

/**
 * Search Console submission repository (#265) — the store {@link SearchConsoleService} writes submission
 * receipts through and the founder console / routes read coverage from. Tenant-scoped throughout (#3).
 * Every read is grounded in a real receipt row; there is no self-reported path (premortem §2).
 */

/** The lifecycle status of a submission receipt. */
export type SubmissionStatus =
  | "pending_approval"
  | "submitted"
  | "verified"
  | "failed"
  | "rejected"
  | "not_connected";

/** What the service records for one submission attempt. */
export interface SubmissionReceiptInput {
  siteUrl: string;
  sitemapUrl: string;
  status: SubmissionStatus;
  approvalRequestId: string | null;
  provider: string;
  accepted: boolean;
  indexedPages: number | null;
  indexingRequested: number;
  detail: string;
}

/** A submission receipt row (the read model for the summary / scorecard). */
export interface SubmissionReceiptRow extends SubmissionReceiptInput {
  id: string;
  createdAtMs: number;
}

export interface SearchConsoleSubmissionStore {
  /** Record one submission receipt. Returns its id. */
  record(workspaceId: string, input: SubmissionReceiptInput): Promise<{ id: string }>;
  /** The most recent receipt for a workspace, or null. */
  latest(workspaceId: string): Promise<SubmissionReceiptRow | null>;
  /** The indexed-page count from the most recent VERIFIED receipt, or null (the scorecard reading). */
  latestVerifiedIndexedPages(workspaceId: string): Promise<number | null>;
}

export const dbSearchConsoleSubmissionStore: SearchConsoleSubmissionStore = {
  async record(workspaceId, input) {
    const [row] = await db
      .insert(searchConsoleSubmissions)
      .values({
        workspaceId,
        siteUrl: input.siteUrl,
        sitemapUrl: input.sitemapUrl,
        status: input.status,
        approvalRequestId: input.approvalRequestId,
        provider: input.provider,
        accepted: input.accepted,
        indexedPages: input.indexedPages,
        indexingRequested: input.indexingRequested,
        detail: input.detail,
      })
      .returning({ id: searchConsoleSubmissions.id });
    return { id: row!.id };
  },

  async latest(workspaceId) {
    const [row] = await db
      .select()
      .from(searchConsoleSubmissions)
      .where(eq(searchConsoleSubmissions.workspaceId, workspaceId))
      .orderBy(desc(searchConsoleSubmissions.createdAt))
      .limit(1);
    return row ? toRow(row) : null;
  },

  async latestVerifiedIndexedPages(workspaceId) {
    const [row] = await db
      .select({ indexedPages: searchConsoleSubmissions.indexedPages })
      .from(searchConsoleSubmissions)
      .where(
        and(
          eq(searchConsoleSubmissions.workspaceId, workspaceId),
          eq(searchConsoleSubmissions.accepted, true),
          isNotNull(searchConsoleSubmissions.indexedPages),
        ),
      )
      .orderBy(desc(searchConsoleSubmissions.createdAt))
      .limit(1);
    return row?.indexedPages ?? null;
  },
};

type SubmissionDbRow = typeof searchConsoleSubmissions.$inferSelect;

function toRow(row: SubmissionDbRow): SubmissionReceiptRow {
  return {
    id: row.id,
    siteUrl: row.siteUrl,
    sitemapUrl: row.sitemapUrl,
    status: row.status as SubmissionStatus,
    approvalRequestId: row.approvalRequestId,
    provider: row.provider,
    accepted: row.accepted,
    indexedPages: row.indexedPages,
    indexingRequested: row.indexingRequested,
    detail: row.detail,
    createdAtMs: row.createdAt.getTime(),
  };
}
