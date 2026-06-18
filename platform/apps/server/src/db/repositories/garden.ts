import { eq } from "drizzle-orm";
import { db } from "../index.js";
import { gardenAgentEnablements } from "../schema/index.js";
import type { GardenAgentState } from "../../garden/types.js";
import type { GardenStateStore } from "../../garden/service.js";

/**
 * Agent Garden enable-state repository (#284) — implements the {@link GardenStateStore} seam the
 * `GardenService` reads/writes through. Tenant-scoped (#3). One row per (workspace, handle); the
 * `(workspace_id, handle)` unique index makes {@link setState} idempotent (a re-toggle updates the row,
 * never duplicates). An absent row reads as `disabled` (default OFF) — that mapping lives in the pure
 * `projectGardenView`, so this store returns only the rows that exist.
 */
export const dbGardenStateStore: GardenStateStore = {
  async getStates(workspaceId: string): Promise<Record<string, GardenAgentState>> {
    const rows = await db
      .select({ handle: gardenAgentEnablements.handle, state: gardenAgentEnablements.state })
      .from(gardenAgentEnablements)
      .where(eq(gardenAgentEnablements.workspaceId, workspaceId));
    const out: Record<string, GardenAgentState> = {};
    for (const r of rows) out[r.handle] = r.state as GardenAgentState;
    return out;
  },

  async setState(workspaceId: string, handle: string, state: GardenAgentState): Promise<void> {
    await db
      .insert(gardenAgentEnablements)
      .values({ workspaceId, handle, state, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [gardenAgentEnablements.workspaceId, gardenAgentEnablements.handle],
        set: { state, updatedAt: new Date() },
      });
  },
};
