import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { realworldArtifacts } from "../schema/index.js";
import type {
  REALWORLD_ARTIFACT_STATUSES,
  REALWORLD_TOOLS,
} from "../schema/realworld.js";
import type { ArtifactRecordInput, ArtifactStore } from "../../realworld/service.js";

/**
 * Real-world artifact receipts repository (#231). Implements the {@link ArtifactStore} seam the actuator
 * service writes through (the in-memory store is the test/default), plus the workspace-scoped reads the
 * founder console uses to surface "real artifacts published" honestly. Tenant-scoped throughout (#3).
 */
export const dbArtifactStore: ArtifactStore = {
  async record(input: ArtifactRecordInput): Promise<{ id: string }> {
    const [row] = await db
      .insert(realworldArtifacts)
      .values({
        workspaceId: input.workspaceId,
        ventureId: input.ventureId,
        tool: input.tool as (typeof REALWORLD_TOOLS)[number],
        url: input.url,
        provider: input.provider,
        status: input.status as (typeof REALWORLD_ARTIFACT_STATUSES)[number],
        approvalRequestId: input.approvalRequestId,
        detail: input.detail,
      })
      .returning({ id: realworldArtifacts.id });
    return { id: row?.id ?? "" };
  },
};

export interface RealworldArtifactRow {
  id: string;
  ventureId: string | null;
  tool: string;
  url: string | null;
  provider: string;
  status: string;
  approvalRequestId: string | null;
  detail: string;
  createdAtMs: number;
}

/** The most recent artifacts for a workspace (the console's "what the fleet shipped" feed). */
export async function listArtifacts(
  workspaceId: string,
  limit = 50,
): Promise<RealworldArtifactRow[]> {
  const rows = await db
    .select()
    .from(realworldArtifacts)
    .where(eq(realworldArtifacts.workspaceId, workspaceId))
    .orderBy(desc(realworldArtifacts.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    ventureId: r.ventureId,
    tool: r.tool,
    url: r.url,
    provider: r.provider,
    status: r.status,
    approvalRequestId: r.approvalRequestId,
    detail: r.detail,
    createdAtMs: r.createdAt.getTime(),
  }));
}

/** Count of artifacts the fleet actually PUBLISHED to a live URL (the honest "real work" signal). */
export async function countPublishedArtifacts(workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: realworldArtifacts.id })
    .from(realworldArtifacts)
    .where(
      and(
        eq(realworldArtifacts.workspaceId, workspaceId),
        eq(realworldArtifacts.status, "published"),
      ),
    );
  return rows.length;
}
