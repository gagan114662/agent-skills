import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  WORKSPACE_RUNTIME_CAPABILITIES,
  workspaceCapabilities,
} from "../schema/index.js";

export type WorkspaceRuntimeCapability = (typeof WORKSPACE_RUNTIME_CAPABILITIES)[number];

export interface WorkspaceCapabilityRow {
  workspaceId: string;
  capability: WorkspaceRuntimeCapability;
  enabled: boolean;
  updatedByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isWorkspaceRuntimeCapability(value: unknown): value is WorkspaceRuntimeCapability {
  return typeof value === "string" && (WORKSPACE_RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

function toRow(row: typeof workspaceCapabilities.$inferSelect): WorkspaceCapabilityRow {
  return {
    workspaceId: row.workspaceId,
    capability: row.capability as WorkspaceRuntimeCapability,
    enabled: row.enabled,
    updatedByMemberId: row.updatedByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listWorkspaceCapabilities(workspaceId: string): Promise<WorkspaceCapabilityRow[]> {
  const rows = await db
    .select()
    .from(workspaceCapabilities)
    .where(eq(workspaceCapabilities.workspaceId, workspaceId));
  return rows.map(toRow);
}

export async function getWorkspaceCapability(
  workspaceId: string,
  capability: WorkspaceRuntimeCapability,
): Promise<WorkspaceCapabilityRow | null> {
  const [row] = await db
    .select()
    .from(workspaceCapabilities)
    .where(
      and(
        eq(workspaceCapabilities.workspaceId, workspaceId),
        eq(workspaceCapabilities.capability, capability),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

export async function setWorkspaceCapability(input: {
  workspaceId: string;
  capability: WorkspaceRuntimeCapability;
  enabled: boolean;
  updatedByMemberId: string;
}): Promise<WorkspaceCapabilityRow> {
  const now = new Date();
  const [row] = await db
    .insert(workspaceCapabilities)
    .values({
      workspaceId: input.workspaceId,
      capability: input.capability,
      enabled: input.enabled,
      updatedByMemberId: input.updatedByMemberId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceCapabilities.workspaceId, workspaceCapabilities.capability],
      set: {
        enabled: input.enabled,
        updatedByMemberId: input.updatedByMemberId,
        updatedAt: now,
      },
    })
    .returning();
  return toRow(row!);
}

