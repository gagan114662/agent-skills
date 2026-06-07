import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { db } from "../index.js";
import { memories, memoryEdges, memoryFiles, taskLinks } from "../schema/index.js";
import type { ContextBuckets } from "../../memory/context.js";

/**
 * Memory repository. Two layers share the `memories` table:
 *   - the #14 task↔memory **shim** (`createMemory`, `memoryInWorkspace`) — validates a link
 *     target in-workspace and lets tests/demo mint a memory. It inserts no `dedupe_key`; a NULL
 *     never collides under the dedup UNIQUE, so those rows simply don't participate in dedup.
 *   - the #15 typed **memory graph** (`upsertMemory`/`getMemory`/`listMemories`/`upsertEdge`/
 *     `getNeighbors`) — workspace-scoped (the #3 IDOR discipline), with idempotent dedup writes.
 */

// --- #14 task↔memory shim -------------------------------------------------------------------

export interface Memory {
  id: string;
  workspaceId: string;
  type: string;
}

export async function createMemory(input: {
  workspaceId: string;
  type: string;
  content?: unknown;
}): Promise<Memory> {
  const [row] = await db
    .insert(memories)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      content: (input.content ?? {}) as object,
    })
    .returning({ id: memories.id, workspaceId: memories.workspaceId, type: memories.type });
  return row as Memory;
}

/** True iff the memory exists *in this workspace* — the link-target IDOR guard. */
export async function memoryInWorkspace(id: string, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.id, id), eq(memories.workspaceId, workspaceId)))
    .limit(1);
  return row !== undefined;
}

// --- #15 typed memory graph -----------------------------------------------------------------

export interface MemoryNode {
  id: string;
  type: string;
  content: { text: string } & Record<string, unknown>;
  entity: string | null;
  sourceType: string | null;
  sourceId: string | null;
  createdByMemberId: string | null;
  /** set ⇒ this node was superseded by a newer one (stale, but kept — issue #16). */
  supersededByMemoryId: string | null;
}

export interface MemoryEdge {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  relation: string;
}

const NODE_COLS = {
  id: memories.id,
  type: memories.type,
  content: memories.content,
  entity: memories.entity,
  sourceType: memories.sourceType,
  sourceId: memories.sourceId,
  createdByMemberId: memories.createdByMemberId,
  supersededByMemoryId: memories.supersededByMemoryId,
};

const EDGE_COLS = {
  id: memoryEdges.id,
  fromMemoryId: memoryEdges.fromMemoryId,
  toMemoryId: memoryEdges.toMemoryId,
  relation: memoryEdges.relation,
};

/** Insert a node, or merge into the existing one sharing its (workspace, dedupe_key). */
export async function upsertMemory(input: {
  workspaceId: string;
  type: string;
  content: { text: string } & Record<string, unknown>;
  entity?: string | null;
  dedupeKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  createdByMemberId?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(memories)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      content: input.content,
      entity: input.entity ?? null,
      dedupeKey: input.dedupeKey,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdByMemberId: input.createdByMemberId ?? null,
    })
    .onConflictDoNothing({ target: [memories.workspaceId, memories.dedupeKey] })
    .returning({ id: memories.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(and(eq(memories.workspaceId, input.workspaceId), eq(memories.dedupeKey, input.dedupeKey)))
    .limit(1);
  return { id: existing!.id, created: false };
}

/** A node by id, scoped to the workspace (undefined if absent or cross-workspace). */
export async function getMemory(
  workspaceId: string,
  id: string,
): Promise<MemoryNode | undefined> {
  const [row] = await db
    .select(NODE_COLS)
    .from(memories)
    .where(and(eq(memories.workspaceId, workspaceId), eq(memories.id, id)))
    .limit(1);
  return row as MemoryNode | undefined;
}

/**
 * Query nodes by optional type and/or entity, newest first. Superseded (stale) nodes are
 * **excluded by default** (issue #16) — pass `includeStale` to surface version history.
 */
export async function listMemories(
  workspaceId: string,
  filter: { type?: string; entity?: string; includeStale?: boolean } = {},
): Promise<MemoryNode[]> {
  const conds: SQL[] = [eq(memories.workspaceId, workspaceId)];
  if (filter.type) conds.push(eq(memories.type, filter.type));
  if (filter.entity) conds.push(eq(memories.entity, filter.entity));
  if (!filter.includeStale) conds.push(isNull(memories.supersededByMemoryId));
  return db
    .select(NODE_COLS)
    .from(memories)
    .where(and(...conds))
    .orderBy(desc(memories.createdAt)) as Promise<MemoryNode[]>;
}

/** Insert a typed edge, or merge into the existing identical one. Idempotent. */
export async function upsertEdge(input: {
  workspaceId: string;
  fromMemoryId: string;
  toMemoryId: string;
  relation: string;
  createdByMemberId?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(memoryEdges)
    .values({
      workspaceId: input.workspaceId,
      fromMemoryId: input.fromMemoryId,
      toMemoryId: input.toMemoryId,
      relation: input.relation,
      createdByMemberId: input.createdByMemberId ?? null,
    })
    .onConflictDoNothing({
      target: [
        memoryEdges.workspaceId,
        memoryEdges.fromMemoryId,
        memoryEdges.toMemoryId,
        memoryEdges.relation,
      ],
    })
    .returning({ id: memoryEdges.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await db
    .select({ id: memoryEdges.id })
    .from(memoryEdges)
    .where(
      and(
        eq(memoryEdges.workspaceId, input.workspaceId),
        eq(memoryEdges.fromMemoryId, input.fromMemoryId),
        eq(memoryEdges.toMemoryId, input.toMemoryId),
        eq(memoryEdges.relation, input.relation),
      ),
    )
    .limit(1);
  return { id: existing!.id, created: false };
}

export interface Neighbors {
  outgoing: MemoryEdge[];
  incoming: MemoryEdge[];
  neighbors: MemoryNode[];
}

/** One-hop traversal: a node's outgoing + incoming edges and the nodes on the other end. */
export async function getNeighbors(workspaceId: string, id: string): Promise<Neighbors> {
  const [outgoing, incoming] = await Promise.all([
    db
      .select(EDGE_COLS)
      .from(memoryEdges)
      .where(and(eq(memoryEdges.workspaceId, workspaceId), eq(memoryEdges.fromMemoryId, id))),
    db
      .select(EDGE_COLS)
      .from(memoryEdges)
      .where(and(eq(memoryEdges.workspaceId, workspaceId), eq(memoryEdges.toMemoryId, id))),
  ]);

  const neighborIds = [
    ...new Set([...outgoing.map((e) => e.toMemoryId), ...incoming.map((e) => e.fromMemoryId)]),
  ];
  const neighbors =
    neighborIds.length === 0
      ? []
      : ((await db
          .select(NODE_COLS)
          .from(memories)
          .where(
            and(eq(memories.workspaceId, workspaceId), inArray(memories.id, neighborIds)),
          )) as MemoryNode[]);

  return { outgoing, incoming, neighbors };
}

/** Nodes by id, scoped to the workspace (preserves caller's id order is not guaranteed). */
async function getMemoriesByIds(workspaceId: string, ids: string[]): Promise<MemoryNode[]> {
  if (ids.length === 0) return [];
  return db
    .select(NODE_COLS)
    .from(memories)
    .where(and(eq(memories.workspaceId, workspaceId), inArray(memories.id, ids))) as Promise<
    MemoryNode[]
  >;
}

// --- #16 supersede / version ----------------------------------------------------------------

/**
 * Supersede `oldId` with a replacement node (issue #16). Upserts the new node (dedup-aware),
 * marks the old node stale (`supersededByMemoryId` + `supersededAt` — **kept, not deleted**),
 * and records a `new --supersedes--> old` edge for lineage. Atomic.
 *
 * If the replacement dedups *into the old node itself* (same statement), it is a no-op: nothing
 * is marked stale and `created` is false. Callers must validate `oldId` is in-workspace first.
 */
export async function supersedeMemory(input: {
  workspaceId: string;
  oldId: string;
  type: string;
  content: { text: string } & Record<string, unknown>;
  entity?: string | null;
  dedupeKey: string;
  sourceType?: string | null;
  sourceId?: string | null;
  createdByMemberId?: string | null;
}): Promise<{ newId: string; created: boolean; superseded: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(memories)
      .values({
        workspaceId: input.workspaceId,
        type: input.type,
        content: input.content,
        entity: input.entity ?? null,
        dedupeKey: input.dedupeKey,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        createdByMemberId: input.createdByMemberId ?? null,
      })
      .onConflictDoNothing({ target: [memories.workspaceId, memories.dedupeKey] })
      .returning({ id: memories.id });

    let newId: string;
    let created: boolean;
    if (inserted[0]) {
      newId = inserted[0].id;
      created = true;
    } else {
      const [existing] = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.workspaceId, input.workspaceId),
            eq(memories.dedupeKey, input.dedupeKey),
          ),
        )
        .limit(1);
      newId = existing!.id;
      created = false;
    }

    // a node never supersedes itself (the replacement dedup'd into the old node)
    if (newId === input.oldId) return { newId, created, superseded: false };

    await tx
      .update(memories)
      .set({ supersededByMemoryId: newId, supersededAt: new Date() })
      .where(and(eq(memories.workspaceId, input.workspaceId), eq(memories.id, input.oldId)));

    await tx
      .insert(memoryEdges)
      .values({
        workspaceId: input.workspaceId,
        fromMemoryId: newId,
        toMemoryId: input.oldId,
        relation: "supersedes",
        createdByMemberId: input.createdByMemberId ?? null,
      })
      .onConflictDoNothing({
        target: [
          memoryEdges.workspaceId,
          memoryEdges.fromMemoryId,
          memoryEdges.toMemoryId,
          memoryEdges.relation,
        ],
      });

    return { newId, created, superseded: true };
  });
}

// --- #16 memory ↔ file links ----------------------------------------------------------------

export interface MemoryFile {
  id: string;
  path: string;
  createdAt: Date;
}

/** Link a memory node to a file path (idempotent per workspace+memory+path). */
export async function linkMemoryFile(input: {
  workspaceId: string;
  memoryId: string;
  path: string;
  createdByMemberId?: string | null;
}): Promise<{ created: boolean }> {
  const inserted = await db
    .insert(memoryFiles)
    .values({
      workspaceId: input.workspaceId,
      memoryId: input.memoryId,
      path: input.path,
      createdByMemberId: input.createdByMemberId ?? null,
    })
    .onConflictDoNothing({
      target: [memoryFiles.workspaceId, memoryFiles.memoryId, memoryFiles.path],
    })
    .returning({ id: memoryFiles.id });
  return { created: inserted.length > 0 };
}

/** Remove a memory↔file link. Returns true iff a link was actually removed. */
export async function unlinkMemoryFile(
  workspaceId: string,
  memoryId: string,
  path: string,
): Promise<boolean> {
  const deleted = await db
    .delete(memoryFiles)
    .where(
      and(
        eq(memoryFiles.workspaceId, workspaceId),
        eq(memoryFiles.memoryId, memoryId),
        eq(memoryFiles.path, path),
      ),
    )
    .returning({ id: memoryFiles.id });
  return deleted.length > 0;
}

/** Forward resolution: the files a memory node is linked to (oldest first). */
export async function listFilesForMemory(memoryId: string): Promise<MemoryFile[]> {
  return db
    .select({ id: memoryFiles.id, path: memoryFiles.path, createdAt: memoryFiles.createdAt })
    .from(memoryFiles)
    .where(eq(memoryFiles.memoryId, memoryId))
    .orderBy(asc(memoryFiles.createdAt)) as Promise<MemoryFile[]>;
}

/** Reverse resolution: the memory nodes linked to a given file path (workspace-scoped). */
export async function listMemoriesForFile(
  workspaceId: string,
  path: string,
): Promise<MemoryNode[]> {
  return db
    .select(NODE_COLS)
    .from(memoryFiles)
    .innerJoin(memories, eq(memories.id, memoryFiles.memoryId))
    .where(and(eq(memoryFiles.workspaceId, workspaceId), eq(memoryFiles.path, path)))
    .orderBy(desc(memories.createdAt)) as Promise<MemoryNode[]>;
}

// --- #16 relevant-context retrieval ---------------------------------------------------------

/**
 * Gather the three candidate buckets for a task's relevant context (issue #16): memories linked
 * to the task (#14 task_links), the 1-hop graph neighbors of those, and memories whose `entity`
 * matches one of the task's labels. The pure `rankRelevantContext` orders/dedups/de-stales them.
 */
export async function taskContextBuckets(
  workspaceId: string,
  taskId: string,
  labels: string[],
): Promise<ContextBuckets> {
  const linkRows = await db
    .select({ targetId: taskLinks.targetId })
    .from(taskLinks)
    .where(
      and(
        eq(taskLinks.workspaceId, workspaceId),
        eq(taskLinks.taskId, taskId),
        eq(taskLinks.targetType, "memory"),
      ),
    );
  const linkedIds = linkRows.map((r) => r.targetId);
  const linked = await getMemoriesByIds(workspaceId, linkedIds);

  const neighborMap = new Map<string, MemoryNode>();
  for (const id of linkedIds) {
    const { neighbors } = await getNeighbors(workspaceId, id);
    for (const node of neighbors) neighborMap.set(node.id, node);
  }
  const neighbors = [...neighborMap.values()];

  const labelMatches =
    labels.length === 0
      ? []
      : ((await db
          .select(NODE_COLS)
          .from(memories)
          .where(
            and(eq(memories.workspaceId, workspaceId), inArray(memories.entity, labels)),
          )) as MemoryNode[]);

  return { linked, neighbors, labelMatches };
}
