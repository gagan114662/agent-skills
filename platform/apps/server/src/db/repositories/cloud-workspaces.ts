import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../index.js";
import { cloudWorkspaces } from "../schema/index.js";

/** Lifecycle of a durable cloud workspace (#55). */
export type CloudWorkspaceStatus = "active" | "sleeping" | "archived";

export interface CloudWorkspace {
  id: string;
  workspaceId: string;
  name: string;
  status: CloudWorkspaceStatus;
  /** Latest filesystem snapshot — the wake/resume key (from a #25 session teardown). Never secrets. */
  snapshotId: string | null;
  /** setup-on-first-mirror: the one-time setup command has run for this workspace. */
  setupCompleted: boolean;
  createdByMemberId: string | null;
  lastActiveAt: Date;
  createdAt: Date;
}

const COLUMNS = {
  id: cloudWorkspaces.id,
  workspaceId: cloudWorkspaces.workspaceId,
  name: cloudWorkspaces.name,
  status: cloudWorkspaces.status,
  snapshotId: cloudWorkspaces.snapshotId,
  setupCompleted: cloudWorkspaces.setupCompleted,
  createdByMemberId: cloudWorkspaces.createdByMemberId,
  lastActiveAt: cloudWorkspaces.lastActiveAt,
  createdAt: cloudWorkspaces.createdAt,
} as const;

export async function createCloudWorkspace(input: {
  workspaceId: string;
  name: string;
  createdByMemberId: string;
}): Promise<CloudWorkspace> {
  const [row] = await db
    .insert(cloudWorkspaces)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      createdByMemberId: input.createdByMemberId,
    })
    .returning(COLUMNS);
  return row as CloudWorkspace;
}

/** Fetch one cloud workspace scoped to its tenant (cross-tenant reads return undefined → 404). */
export async function getCloudWorkspace(
  id: string,
  workspaceId: string,
): Promise<CloudWorkspace | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(cloudWorkspaces)
    .where(and(eq(cloudWorkspaces.id, id), eq(cloudWorkspaces.workspaceId, workspaceId)))
    .limit(1);
  return row as CloudWorkspace | undefined;
}

/** All cloud workspaces in a tenant, newest first (the route filters to what the caller may see). */
export async function listCloudWorkspaces(workspaceId: string): Promise<CloudWorkspace[]> {
  const rows = await db
    .select(COLUMNS)
    .from(cloudWorkspaces)
    .where(eq(cloudWorkspaces.workspaceId, workspaceId))
    .orderBy(desc(cloudWorkspaces.createdAt));
  return rows as CloudWorkspace[];
}

/** Fetch several cloud workspaces by id within a tenant (used to resolve "shared with me"). */
export async function listCloudWorkspacesByIds(
  workspaceId: string,
  ids: string[],
): Promise<CloudWorkspace[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select(COLUMNS)
    .from(cloudWorkspaces)
    .where(and(eq(cloudWorkspaces.workspaceId, workspaceId), inArray(cloudWorkspaces.id, ids)))
    .orderBy(desc(cloudWorkspaces.createdAt));
  return rows as CloudWorkspace[];
}

/** Transition a cloud workspace's lifecycle status (sleep/wake/archive). */
export async function setCloudWorkspaceStatus(
  id: string,
  status: CloudWorkspaceStatus,
): Promise<void> {
  await db.update(cloudWorkspaces).set({ status }).where(eq(cloudWorkspaces.id, id));
}

/** Record the latest filesystem snapshot (resume key) and mark the workspace freshly active. */
export async function recordCloudWorkspaceSnapshot(id: string, snapshotId: string): Promise<void> {
  await db
    .update(cloudWorkspaces)
    .set({ snapshotId, lastActiveAt: new Date() })
    .where(eq(cloudWorkspaces.id, id));
}

/** Mark the one-time setup as done (setup-on-first-mirror). Idempotent. */
export async function markCloudWorkspaceSetupCompleted(id: string): Promise<void> {
  await db
    .update(cloudWorkspaces)
    .set({ setupCompleted: true })
    .where(eq(cloudWorkspaces.id, id));
}

/** Bump `lastActiveAt` so the idle sweep does not sleep an in-use workspace. */
export async function touchCloudWorkspace(id: string): Promise<void> {
  await db
    .update(cloudWorkspaces)
    .set({ lastActiveAt: new Date() })
    .where(eq(cloudWorkspaces.id, id));
}

/** Active workspaces idle since before `idleBefore` — the idle sweep sleeps these. */
export async function listSleepCandidates(idleBefore: Date): Promise<CloudWorkspace[]> {
  const rows = await db
    .select(COLUMNS)
    .from(cloudWorkspaces)
    .where(and(eq(cloudWorkspaces.status, "active"), lt(cloudWorkspaces.lastActiveAt, idleBefore)));
  return rows as CloudWorkspace[];
}
