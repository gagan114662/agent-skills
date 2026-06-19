import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../index.js";
import { attributionExposures } from "../schema/index.js";
import type { Exposure } from "../../attribution/chain.js";
import type { AttributionExposureStore, RecordExposureInput } from "../../attribution/store.js";

/**
 * Attributed-revenue ledger exposure repository (#386, ADR-0386). Implements the
 * {@link AttributionExposureStore} seam the attribution service writes through when the fleet really ships
 * something live, plus the workspace-scoped read the projection joins to revenue receipts. Tenant-scoped
 * throughout (#3). Holds no secret and no money — only an artifact id, a tracking ref, a channel, timestamps.
 *
 * Idempotency is the unique `(workspace_id, tracking_ref)` constraint: `recordExposure` does ON CONFLICT
 * DO NOTHING, so re-stamping the same artifact records ONE exposure row and returns the existing id.
 */
export const dbAttributionExposureStore: AttributionExposureStore = {
  async recordExposure(input: RecordExposureInput): Promise<{ id: string }> {
    const inserted = await db
      .insert(attributionExposures)
      .values({
        workspaceId: input.workspaceId,
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        trackingRef: input.trackingRef,
        channel: input.channel,
        occurredAt: new Date(input.occurredAtMs),
      })
      .onConflictDoNothing({
        target: [attributionExposures.workspaceId, attributionExposures.trackingRef],
      })
      .returning({ id: attributionExposures.id });
    if (inserted[0]) return { id: inserted[0].id };
    // Conflict: the exposure already exists for this (workspace, ref). Return the existing row's id.
    const [existing] = await db
      .select({ id: attributionExposures.id })
      .from(attributionExposures)
      .where(
        and(
          eq(attributionExposures.workspaceId, input.workspaceId),
          eq(attributionExposures.trackingRef, input.trackingRef),
        ),
      )
      .limit(1);
    return { id: existing?.id ?? "" };
  },

  async listExposures(workspaceId: string, sinceMs?: number): Promise<Exposure[]> {
    const conds = [eq(attributionExposures.workspaceId, workspaceId)];
    if (sinceMs !== undefined) conds.push(gt(attributionExposures.occurredAt, new Date(sinceMs)));
    const rows = await db
      .select({
        artifactId: attributionExposures.artifactId,
        artifactKind: attributionExposures.artifactKind,
        trackingRef: attributionExposures.trackingRef,
        channel: attributionExposures.channel,
        occurredAt: attributionExposures.occurredAt,
      })
      .from(attributionExposures)
      .where(and(...conds))
      .orderBy(asc(attributionExposures.occurredAt))
      .limit(1000);
    return rows.map((r) => ({
      artifactId: r.artifactId,
      artifactKind: r.artifactKind,
      trackingRef: r.trackingRef,
      channel: r.channel,
      occurredAtMs: r.occurredAt.getTime(),
    }));
  },
};
