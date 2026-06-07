import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "../index.js";
import { memories, memoryEdges } from "../schema/index.js";

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

/** Query nodes by optional type and/or entity, newest first. */
export async function listMemories(
  workspaceId: string,
  filter: { type?: string; entity?: string } = {},
): Promise<MemoryNode[]> {
  const conds: SQL[] = [eq(memories.workspaceId, workspaceId)];
  if (filter.type) conds.push(eq(memories.type, filter.type));
  if (filter.entity) conds.push(eq(memories.entity, filter.entity));
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
