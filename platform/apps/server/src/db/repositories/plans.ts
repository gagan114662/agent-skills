import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import { workspacePlans, billingPlanPrices } from "../schema/index.js";
import type {
  ActivePlan,
  PlanPriceRow,
  PlanPriceStore,
  WorkspacePlanStore,
} from "../../billing/plan-service.js";
import type { PlanKey } from "../../billing/plans.js";

/**
 * Repository-backed plan stores (#125) implementing the injectable seams the {@link
 * import("../../billing/plan-service.js").PlanBillingService} consumes — so unit tests inject in-memory
 * stores while production persists durably. All access is **workspace-scoped** (#9, IDOR-safe). Webhook
 * idempotency is the unique key on `revenue_events` (#98); price idempotency is the composite PK here.
 */

/** Coerce a selected `workspace_plans` row into the domain {@link ActivePlan}. */
function toActivePlan(row: {
  workspaceId: string;
  planKey: string;
  status: string;
  agentSeats: number;
  monthlySessionBudgetCents: number;
  fleetSize: number;
  providerEventId: string | null;
  activatedAt: Date;
}): ActivePlan {
  return { ...row, planKey: row.planKey as PlanKey };
}

export const dbWorkspacePlanStore: WorkspacePlanStore = {
  async getActive(workspaceId: string): Promise<ActivePlan | undefined> {
    const [row] = await db
      .select({
        workspaceId: workspacePlans.workspaceId,
        planKey: workspacePlans.planKey,
        status: workspacePlans.status,
        agentSeats: workspacePlans.agentSeats,
        monthlySessionBudgetCents: workspacePlans.monthlySessionBudgetCents,
        fleetSize: workspacePlans.fleetSize,
        providerEventId: workspacePlans.providerEventId,
        activatedAt: workspacePlans.activatedAt,
      })
      .from(workspacePlans)
      .where(eq(workspacePlans.workspaceId, workspaceId))
      .limit(1);
    return row ? toActivePlan(row) : undefined;
  },

  async activate(input): Promise<ActivePlan> {
    const values = {
      workspaceId: input.workspaceId,
      planKey: input.planKey,
      status: "active",
      agentSeats: input.caps.agentSeats,
      monthlySessionBudgetCents: input.caps.monthlySessionBudgetCents,
      fleetSize: input.caps.fleetSize,
      providerEventId: input.providerEventId,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(workspacePlans)
      .values(values)
      .onConflictDoUpdate({
        target: workspacePlans.workspaceId,
        set: {
          planKey: values.planKey,
          status: values.status,
          agentSeats: values.agentSeats,
          monthlySessionBudgetCents: values.monthlySessionBudgetCents,
          fleetSize: values.fleetSize,
          providerEventId: values.providerEventId,
          updatedAt: values.updatedAt,
        },
      })
      .returning({
        workspaceId: workspacePlans.workspaceId,
        planKey: workspacePlans.planKey,
        status: workspacePlans.status,
        agentSeats: workspacePlans.agentSeats,
        monthlySessionBudgetCents: workspacePlans.monthlySessionBudgetCents,
        fleetSize: workspacePlans.fleetSize,
        providerEventId: workspacePlans.providerEventId,
        activatedAt: workspacePlans.activatedAt,
      });
    return toActivePlan(row!);
  },
};

export const dbPlanPriceStore: PlanPriceStore = {
  async find(
    workspaceId: string,
    planKey: PlanKey,
    provider: string,
  ): Promise<{ productId: string; priceId: string } | undefined> {
    const [row] = await db
      .select({ productId: billingPlanPrices.productId, priceId: billingPlanPrices.priceId })
      .from(billingPlanPrices)
      .where(
        and(
          eq(billingPlanPrices.workspaceId, workspaceId),
          eq(billingPlanPrices.planKey, planKey),
          eq(billingPlanPrices.provider, provider),
        ),
      )
      .limit(1);
    return row ?? undefined;
  },

  async upsert(row: PlanPriceRow): Promise<void> {
    // ON CONFLICT DO NOTHING on the composite PK: the first writer wins, so a repeat bootstrap or a
    // concurrent checkout never creates a duplicate product/price registry row.
    await db
      .insert(billingPlanPrices)
      .values({
        workspaceId: row.workspaceId,
        planKey: row.planKey,
        provider: row.provider,
        productId: row.productId,
        priceId: row.priceId,
      })
      .onConflictDoNothing({
        target: [billingPlanPrices.workspaceId, billingPlanPrices.planKey, billingPlanPrices.provider],
      });
  },
};
