import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { memories } from "../schema/index.js";

/**
 * Minimal memory shim — just enough for #14 task↔memory links to validate a target in-workspace
 * and for tests/demo to create one. The full typed memory graph is #15 (the stub stays untouched).
 */
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
