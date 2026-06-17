import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { analyticsInstalls } from "../schema/index.js";
import type { AnalyticsInstall, AnalyticsInstallStore } from "../../analytics/types.js";
import type { AnalyticsInstallMethod } from "../../analytics/decide.js";

/**
 * Analytics install repository (#270) — implements the {@link AnalyticsInstallStore} seam `AnalyticsService`
 * reads/writes through. Tenant-scoped (#3). One row per workspace; the `(workspace_id)` unique index makes
 * {@link upsert} idempotent (re-install updates the existing row, never duplicates).
 */
export const dbAnalyticsInstallStore: AnalyticsInstallStore = {
  async get(workspaceId: string): Promise<AnalyticsInstall | null> {
    const [row] = await db
      .select()
      .from(analyticsInstalls)
      .where(eq(analyticsInstalls.workspaceId, workspaceId))
      .limit(1);
    if (!row) return null;
    return {
      workspaceId: row.workspaceId,
      method: row.method as AnalyticsInstallMethod,
      provider: row.provider,
      measurementId: row.measurementId,
      snippetFingerprint: row.snippetFingerprint,
      installedAtMs: row.installedAt.getTime(),
      updatedAtMs: row.updatedAt.getTime(),
    };
  },

  async upsert(install: AnalyticsInstall): Promise<void> {
    await db
      .insert(analyticsInstalls)
      .values({
        workspaceId: install.workspaceId,
        method: install.method,
        provider: install.provider,
        measurementId: install.measurementId,
        snippetFingerprint: install.snippetFingerprint,
        installedAt: new Date(install.installedAtMs),
        updatedAt: new Date(install.updatedAtMs),
      })
      .onConflictDoUpdate({
        target: analyticsInstalls.workspaceId,
        set: {
          method: install.method,
          provider: install.provider,
          measurementId: install.measurementId,
          snippetFingerprint: install.snippetFingerprint,
          updatedAt: new Date(install.updatedAtMs),
        },
      });
  },
};
