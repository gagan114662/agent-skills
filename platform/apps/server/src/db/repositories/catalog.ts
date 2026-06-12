import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { catalogEntries } from "../schema/index.js";
import type { CatalogEntry, CatalogEntryInput, CatalogKind } from "../../catalog/types.js";

/**
 * Durable store for the Workspace Catalog (#152, ADR-0152) over `catalog_entries`. Every read filters
 * `workspace_id` (the #3 tenant boundary) — there is no cross-workspace read. Mirrors the automations
 * repo shape (explicit column map + a `toEntry` mapper).
 */

const C_COLUMNS = {
  id: catalogEntries.id,
  workspaceId: catalogEntries.workspaceId,
  kind: catalogEntries.kind,
  name: catalogEntries.name,
  identifier: catalogEntries.identifier,
  status: catalogEntries.status,
  provenance: catalogEntries.provenance,
  ownerMemberId: catalogEntries.ownerMemberId,
  metadata: catalogEntries.metadata,
  createdByMemberId: catalogEntries.createdByMemberId,
  createdAt: catalogEntries.createdAt,
  updatedAt: catalogEntries.updatedAt,
} as const;

function toEntry(row: Record<string, unknown>): CatalogEntry {
  return {
    ...(row as Omit<CatalogEntry, "metadata">),
    metadata: (row.metadata as Record<string, string>) ?? {},
  } as CatalogEntry;
}

export async function createCatalogEntry(
  workspaceId: string,
  createdByMemberId: string,
  input: CatalogEntryInput,
): Promise<CatalogEntry> {
  const [row] = await db
    .insert(catalogEntries)
    .values({
      workspaceId,
      kind: input.kind,
      name: input.name,
      identifier: input.identifier ?? "",
      status: input.status ?? "active",
      provenance: input.provenance ?? "manual",
      ownerMemberId: input.ownerMemberId ?? null,
      metadata: input.metadata ?? {},
      createdByMemberId,
    })
    .returning(C_COLUMNS);
  return toEntry(row!);
}

export async function getCatalogEntry(workspaceId: string, id: string): Promise<CatalogEntry | null> {
  const [row] = await db
    .select(C_COLUMNS)
    .from(catalogEntries)
    .where(and(eq(catalogEntries.workspaceId, workspaceId), eq(catalogEntries.id, id)))
    .limit(1);
  return row ? toEntry(row) : null;
}

export async function listCatalogEntries(workspaceId: string, kind?: CatalogKind): Promise<CatalogEntry[]> {
  const where = kind
    ? and(eq(catalogEntries.workspaceId, workspaceId), eq(catalogEntries.kind, kind))
    : eq(catalogEntries.workspaceId, workspaceId);
  const rows = await db.select(C_COLUMNS).from(catalogEntries).where(where).orderBy(desc(catalogEntries.createdAt));
  return rows.map(toEntry);
}

export async function countCatalogEntries(workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(catalogEntries)
    .where(eq(catalogEntries.workspaceId, workspaceId));
  return row?.n ?? 0;
}

export async function updateCatalogEntry(
  workspaceId: string,
  id: string,
  patch: Partial<CatalogEntryInput>,
): Promise<CatalogEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.identifier !== undefined) set.identifier = patch.identifier;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.provenance !== undefined) set.provenance = patch.provenance;
  if (patch.ownerMemberId !== undefined) set.ownerMemberId = patch.ownerMemberId;
  if (patch.metadata !== undefined) set.metadata = patch.metadata;
  const [row] = await db
    .update(catalogEntries)
    .set(set)
    .where(and(eq(catalogEntries.workspaceId, workspaceId), eq(catalogEntries.id, id)))
    .returning(C_COLUMNS);
  return row ? toEntry(row) : null;
}

export async function deleteCatalogEntry(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(catalogEntries)
    .where(and(eq(catalogEntries.workspaceId, workspaceId), eq(catalogEntries.id, id)))
    .returning({ id: catalogEntries.id });
  return deleted.length > 0;
}
