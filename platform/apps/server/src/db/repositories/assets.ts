import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../index.js";
import { brandKits, workspaceAssets } from "../schema/index.js";
import type {
  AssetStore,
  BrandKitStore,
  BrandKitRecord,
  StoredAsset,
  StoredAssetInput,
} from "../../assets/service.js";
import type { BrandKit } from "../../assets/types.js";

/**
 * Brand kit + asset store repositories (#271). Implement the {@link BrandKitStore} / {@link AssetStore}
 * seams the {@link AssetService} writes through. Tenant-scoped by `workspace_id` throughout (#3).
 *
 * `setActive` is the "set once" guarantee: it archives the current active kit then inserts the new one,
 * so the partial unique index (`brand_kits_one_active_idx`, one active per workspace) always holds. The
 * two writes run in a transaction so a workspace is never momentarily left with zero or two active kits.
 */

function rowToKit(row: typeof brandKits.$inferSelect): BrandKit {
  return {
    name: row.name,
    palette: (row.palette ?? []) as string[],
    voice: row.voice,
    logoAssetId: row.logoAssetId,
  };
}

export const dbBrandKitStore: BrandKitStore = {
  async getActive(workspaceId: string): Promise<BrandKitRecord | null> {
    const [row] = await db
      .select()
      .from(brandKits)
      .where(and(eq(brandKits.workspaceId, workspaceId), eq(brandKits.status, "active")))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      kit: rowToKit(row),
      createdAtMs: row.createdAt.getTime(),
      updatedAtMs: row.updatedAt.getTime(),
    };
  },

  async setActive(workspaceId: string, kit: BrandKit): Promise<BrandKitRecord> {
    return db.transaction(async (tx) => {
      await tx
        .update(brandKits)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(brandKits.workspaceId, workspaceId), eq(brandKits.status, "active")));
      const [row] = await tx
        .insert(brandKits)
        .values({
          workspaceId,
          name: kit.name,
          palette: kit.palette,
          voice: kit.voice,
          logoAssetId: kit.logoAssetId,
          status: "active",
        })
        .returning();
      if (!row) throw new Error("failed to insert brand kit");
      return {
        id: row.id,
        kit: rowToKit(row),
        createdAtMs: row.createdAt.getTime(),
        updatedAtMs: row.updatedAt.getTime(),
      };
    });
  },
};

function rowToAsset(row: typeof workspaceAssets.$inferSelect): StoredAsset {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ventureId: row.ventureId,
    kind: row.kind,
    mime: row.mime,
    title: row.title,
    data: row.data,
    brandKitId: row.brandKitId,
    onBrand: row.onBrand,
    sourceTool: row.sourceTool,
    draftRef: row.draftRef,
    provider: row.provider,
    detail: row.detail,
    createdAtMs: row.createdAt.getTime(),
  };
}

export const dbAssetStore: AssetStore = {
  async insert(input: StoredAssetInput): Promise<StoredAsset> {
    const [row] = await db
      .insert(workspaceAssets)
      .values({
        workspaceId: input.workspaceId,
        ventureId: input.ventureId,
        kind: input.kind,
        mime: input.mime,
        title: input.title,
        data: input.data,
        brandKitId: input.brandKitId,
        onBrand: input.onBrand,
        sourceTool: input.sourceTool,
        draftRef: input.draftRef,
        provider: input.provider,
        detail: input.detail,
      })
      .returning();
    if (!row) throw new Error("failed to insert asset");
    return rowToAsset(row);
  },

  async list(workspaceId: string, limit = 50): Promise<StoredAsset[]> {
    const rows = await db
      .select()
      .from(workspaceAssets)
      .where(eq(workspaceAssets.workspaceId, workspaceId))
      .orderBy(desc(workspaceAssets.createdAt))
      .limit(limit);
    return rows.map(rowToAsset);
  },

  async count(workspaceId: string): Promise<number> {
    // Aggregate in the database (not in memory) so the count stays cheap as the store grows.
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceAssets)
      .where(eq(workspaceAssets.workspaceId, workspaceId));
    return Number(row?.count ?? 0);
  },
};
