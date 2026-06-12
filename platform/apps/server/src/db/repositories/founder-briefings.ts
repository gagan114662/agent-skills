import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { founderBriefings } from "../schema/index.js";
import type { DeliveryStore } from "../../founder-briefings/service.js";
import type { ChannelResult, DigestKind } from "../../founder-briefings/notifier.js";

/**
 * Founder Briefings delivery audit repository (#173, ADR-0173). Workspace-scoped throughout (the #3 IDOR
 * discipline). Implements the {@link DeliveryStore} seam the {@link FounderBriefingsService} injects —
 * the idempotency watermark (`wasDelivered`) + the append-only send log (`record`). The unique
 * `(workspace_id, kind, period_key)` makes `record` idempotent under a concurrent tick.
 */
export const dbDeliveryStore: DeliveryStore = {
  async wasDelivered(workspaceId: string, kind: DigestKind, periodKey: string): Promise<boolean> {
    const [row] = await db
      .select({ id: founderBriefings.id })
      .from(founderBriefings)
      .where(
        and(
          eq(founderBriefings.workspaceId, workspaceId),
          eq(founderBriefings.kind, kind),
          eq(founderBriefings.periodKey, periodKey),
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  async record(input): Promise<void> {
    await db
      .insert(founderBriefings)
      .values({
        workspaceId: input.workspaceId,
        kind: input.kind,
        periodKey: input.periodKey,
        delivered: input.delivered,
        channels: input.channels,
        wordCount: input.wordCount,
      })
      // The watermark: a duplicate (workspace, kind, period) audits once — a repeat tick is a no-op.
      .onConflictDoNothing({
        target: [founderBriefings.workspaceId, founderBriefings.kind, founderBriefings.periodKey],
      });
  },
};

/** One persisted delivery audit row (the read shape for the route's history endpoint, if needed). */
export interface BriefingDeliveryRow {
  id: string;
  kind: DigestKind;
  periodKey: string;
  delivered: boolean;
  channels: ChannelResult[];
  wordCount: number;
  createdAtMs: number;
}

/** Recent delivery audit rows for a workspace, newest first (read-only, tenant-scoped). */
export async function listBriefingDeliveries(
  workspaceId: string,
  limit = 50,
): Promise<BriefingDeliveryRow[]> {
  const rows = await db
    .select({
      id: founderBriefings.id,
      kind: founderBriefings.kind,
      periodKey: founderBriefings.periodKey,
      delivered: founderBriefings.delivered,
      channels: founderBriefings.channels,
      wordCount: founderBriefings.wordCount,
      createdAt: founderBriefings.createdAt,
    })
    .from(founderBriefings)
    .where(eq(founderBriefings.workspaceId, workspaceId))
    .orderBy(desc(founderBriefings.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as DigestKind,
    periodKey: r.periodKey,
    delivered: r.delivered,
    channels: (r.channels as ChannelResult[]) ?? [],
    wordCount: r.wordCount,
    createdAtMs: r.createdAt.getTime(),
  }));
}
