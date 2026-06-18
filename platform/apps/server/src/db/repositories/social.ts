import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { socialPosts, socialPostResults } from "../schema/index.js";
import type { SocialNetwork, SocialPostStatus } from "../../social/decide.js";
import type {
  CreateSocialDraftInput,
  RecordSocialResultInput,
  SocialPostRecord,
  SocialPostResultRecord,
  SocialPostStore,
  SocialResultStore,
} from "../../social/store.js";

/**
 * #269 social-posting repositories. Tenant-scoped throughout (#3 — every write carries workspace_id and the
 * FK cascades on workspace delete). The repos implement the {@link SocialPostStore}/{@link SocialResultStore}
 * seams the service writes through; the in-memory fakes in the unit tests prove the service logic without a
 * DB. The `networks` allow-list round-trips through a comma-joined column.
 */

type PostRow = typeof socialPosts.$inferSelect;
type ResultRow = typeof socialPostResults.$inferSelect;

function splitNetworks(value: string): SocialNetwork[] {
  return value
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0) as SocialNetwork[];
}

function toPost(r: PostRow): SocialPostRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    body: r.body,
    networks: splitNetworks(r.networks),
    scheduledAt: r.scheduledAt ? r.scheduledAt.toISOString() : null,
    status: r.status as SocialPostStatus,
    approvalRequestId: r.approvalRequestId,
    aggregatorRef: r.aggregatorRef,
    createdAt: r.createdAt.toISOString(),
  };
}

function toResult(r: ResultRow): SocialPostResultRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    postId: r.postId,
    network: r.network as SocialNetwork,
    status: r.status as "published" | "scheduled" | "failed",
    externalId: r.externalId,
    permalink: r.permalink,
    error: r.error,
    recordedAt: r.recordedAt.toISOString(),
  };
}

export const dbSocialPostStore: SocialPostStore = {
  async getById(id) {
    const [row] = await db.select().from(socialPosts).where(eq(socialPosts.id, id)).limit(1);
    return row ? toPost(row) : null;
  },
  async createDraft(input: CreateSocialDraftInput) {
    const [row] = await db
      .insert(socialPosts)
      .values({
        workspaceId: input.workspaceId,
        body: input.body,
        networks: input.networks.join(","),
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
        status: "draft",
      })
      .returning();
    return toPost(row!);
  },
  async applyStatus(id, patch) {
    const set: Record<string, unknown> = { status: patch.status, updatedAt: sql`now()` };
    if (patch.approvalRequestId !== undefined) set.approvalRequestId = patch.approvalRequestId;
    if (patch.aggregatorRef !== undefined) set.aggregatorRef = patch.aggregatorRef;
    const [row] = await db.update(socialPosts).set(set).where(eq(socialPosts.id, id)).returning();
    return row ? toPost(row) : null;
  },
  async listByWorkspace(workspaceId, limit = 50) {
    const rows = await db
      .select()
      .from(socialPosts)
      .where(eq(socialPosts.workspaceId, workspaceId))
      .orderBy(desc(socialPosts.createdAt))
      .limit(limit);
    return rows.map(toPost);
  },
};

export const dbSocialResultStore: SocialResultStore = {
  async record(postId, results: readonly RecordSocialResultInput[]) {
    // A publish attempt replaces the prior receipts for the post (idempotent per attempt).
    await db.delete(socialPostResults).where(eq(socialPostResults.postId, postId));
    if (results.length === 0) return;
    await db.insert(socialPostResults).values(
      results.map((r) => ({
        workspaceId: r.workspaceId,
        postId: r.postId,
        network: r.network,
        status: r.status,
        externalId: r.externalId,
        permalink: r.permalink,
        error: r.error,
      })),
    );
  },
  async listForPost(postId) {
    const rows = await db
      .select()
      .from(socialPostResults)
      .where(eq(socialPostResults.postId, postId))
      .orderBy(socialPostResults.recordedAt);
    return rows.map(toResult);
  },
  async countPublishedForWorkspace(workspaceId) {
    const rows = await db
      .select({ id: socialPostResults.id })
      .from(socialPostResults)
      .where(
        and(
          eq(socialPostResults.workspaceId, workspaceId),
          eq(socialPostResults.status, "published"),
        ),
      );
    return rows.length;
  },
};
