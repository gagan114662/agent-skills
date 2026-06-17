import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { provisioningUsage } from "../schema/index.js";
import type { UsageRecord } from "../../provisioning/usage.js";
import type { UsageStore } from "../../provisioning/service.js";

/**
 * The persistence for the central-provisioning usage ledger (#267, ADR-0267). Implements the injected
 * {@link UsageStore} the {@link ProvisioningService} writes through, plus a tenant-scoped read for the
 * billing surface. Holds no secret — only structural metering. The `verified` flag is taken from the
 * already-shaped {@link UsageRecord} (the service derives it from the external receipt, never the client).
 */
export const dbProvisioningUsageStore: UsageStore = {
  async record(row: UsageRecord): Promise<void> {
    await db.insert(provisioningUsage).values({
      workspaceId: row.workspaceId,
      capabilityId: row.capabilityId,
      provider: row.provider,
      units: row.units,
      costCents: row.costCents,
      externalRef: row.externalRef,
      verified: row.verified,
      occurredAt: new Date(row.occurredAtMs),
    });
  },
};

/** Recent usage rows for a workspace (newest first), tenant-scoped (#3). For the billing/read surface. */
export async function listProvisioningUsage(
  workspaceId: string,
  opts: { capabilityId?: string; limit?: number } = {},
): Promise<UsageRecord[]> {
  const where = opts.capabilityId
    ? and(
        eq(provisioningUsage.workspaceId, workspaceId),
        eq(provisioningUsage.capabilityId, opts.capabilityId),
      )
    : eq(provisioningUsage.workspaceId, workspaceId);
  const rows = await db
    .select()
    .from(provisioningUsage)
    .where(where)
    .orderBy(desc(provisioningUsage.occurredAt))
    .limit(opts.limit ?? 200);
  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    capabilityId: r.capabilityId,
    provider: r.provider,
    units: r.units,
    costCents: r.costCents,
    externalRef: r.externalRef,
    verified: r.verified,
    occurredAtMs: r.occurredAt.getTime(),
  }));
}
