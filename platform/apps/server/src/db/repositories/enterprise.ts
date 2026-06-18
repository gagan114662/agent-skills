import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { enterpriseUsage, enterpriseBudgetCaps } from "../schema/index.js";
import type { UsageReceipt } from "../../enterprise/metering.js";
import type { BudgetCap, BudgetScope } from "../../enterprise/budget.js";
import type { EnterpriseUsageStore, EnterpriseBudgetStore } from "../../enterprise/service.js";

/**
 * Persistence for the enterprise metering ledger + budget caps (#340, ADR-0340). Implements the injected
 * {@link EnterpriseUsageStore} + {@link EnterpriseBudgetStore} the {@link EnterpriseService} writes/reads
 * through. Holds no secret — only structural metering + the pre-committed caps. `verified` is taken from the
 * already-shaped {@link UsageReceipt} (the service derives it from the external receipt, never the client).
 */
export const dbEnterpriseUsageStore: EnterpriseUsageStore = {
  async record(receipt: UsageReceipt): Promise<void> {
    await db.insert(enterpriseUsage).values({
      workspaceId: receipt.workspaceId,
      agentId: receipt.agentId,
      kind: receipt.kind,
      resource: receipt.resource,
      provider: receipt.provider,
      units: receipt.units,
      costCents: receipt.costCents,
      externalRef: receipt.externalRef,
      verified: receipt.verified,
      receiptId: receipt.receiptId,
      occurredAt: new Date(receipt.occurredAtMs),
    });
  },

  async listByWorkspace(workspaceId: string, limit: number): Promise<UsageReceipt[]> {
    const rows = await db
      .select()
      .from(enterpriseUsage)
      .where(eq(enterpriseUsage.workspaceId, workspaceId))
      .orderBy(desc(enterpriseUsage.occurredAt))
      .limit(limit);
    return rows.map((r) => ({
      receiptId: r.receiptId,
      workspaceId: r.workspaceId,
      agentId: r.agentId,
      kind: r.kind as UsageReceipt["kind"],
      resource: r.resource,
      provider: r.provider,
      units: r.units,
      costCents: r.costCents,
      externalRef: r.externalRef,
      provenance: r.verified ? "external" : "internal_estimate",
      verified: r.verified,
      occurredAtMs: r.occurredAt.getTime(),
    }));
  },
};

export const dbEnterpriseBudgetStore: EnterpriseBudgetStore = {
  async getCap(workspaceId: string, scope: BudgetScope, subjectId: string): Promise<BudgetCap | null> {
    const [row] = await db
      .select()
      .from(enterpriseBudgetCaps)
      .where(
        and(
          eq(enterpriseBudgetCaps.workspaceId, workspaceId),
          eq(enterpriseBudgetCaps.scope, scope),
          eq(enterpriseBudgetCaps.subjectId, subjectId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      scope: row.scope as BudgetScope,
      subjectId: row.subjectId,
      capCents: row.capCents,
      committedCents: row.committedCents,
    };
  },
};

/** All provisioned budget caps for a workspace (newest first) — for the read surface. */
export async function listEnterpriseBudgetCaps(workspaceId: string): Promise<BudgetCap[]> {
  const rows = await db
    .select()
    .from(enterpriseBudgetCaps)
    .where(eq(enterpriseBudgetCaps.workspaceId, workspaceId))
    .orderBy(desc(enterpriseBudgetCaps.updatedAt));
  return rows.map((r) => ({
    scope: r.scope as BudgetScope,
    subjectId: r.subjectId,
    capCents: r.capCents,
    committedCents: r.committedCents,
  }));
}
