import { and, eq } from "drizzle-orm";
import { db } from "../index.js";
import {
  billingPlanPrices,
  pricingExperimentAssignments,
  pricingExperimentVariants,
  pricingExperiments,
  workspacePlans,
} from "../schema/index.js";
import { newId } from "../id.js";
import type {
  ActivePlan,
  PlanPriceRow,
  PlanPriceStore,
  PricingAssignment,
  PricingExperiment,
  PricingExperimentStatus,
  PricingExperimentStore,
  PricingExperimentVariant,
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

function toPricingExperiment(
  row: {
    id: string;
    workspaceId: string;
    name: string;
    status: string;
    controlVariantKey: string;
    minSampleSize: number;
    createdAt: Date;
  },
  variants: PricingExperimentVariant[],
): PricingExperiment {
  return {
    ...row,
    status: row.status as PricingExperimentStatus,
    variants,
  };
}

function toPricingAssignment(row: {
  id: string;
  workspaceId: string;
  experimentId: string;
  subjectKey: string;
  variantKey: string;
  planKey: string;
  checkoutStartedAt: Date | null;
  convertedAt: Date | null;
  revenueEventId: string | null;
  revenueCents: number;
  createdAt: Date;
}): PricingAssignment {
  return { ...row, planKey: row.planKey as PlanKey };
}

async function variantsFor(experimentId: string): Promise<PricingExperimentVariant[]> {
  const rows = await db
    .select({
      key: pricingExperimentVariants.variantKey,
      planKey: pricingExperimentVariants.planKey,
      label: pricingExperimentVariants.label,
      weightBps: pricingExperimentVariants.weightBps,
    })
    .from(pricingExperimentVariants)
    .where(eq(pricingExperimentVariants.experimentId, experimentId));
  return rows.map((r) => ({ ...r, planKey: r.planKey as PlanKey }));
}

async function experimentById(
  workspaceId: string,
  experimentId: string,
): Promise<PricingExperiment | undefined> {
  const [row] = await db
    .select({
      id: pricingExperiments.id,
      workspaceId: pricingExperiments.workspaceId,
      name: pricingExperiments.name,
      status: pricingExperiments.status,
      controlVariantKey: pricingExperiments.controlVariantKey,
      minSampleSize: pricingExperiments.minSampleSize,
      createdAt: pricingExperiments.createdAt,
    })
    .from(pricingExperiments)
    .where(and(eq(pricingExperiments.workspaceId, workspaceId), eq(pricingExperiments.id, experimentId)))
    .limit(1);
  if (!row) return undefined;
  return toPricingExperiment(row, await variantsFor(row.id));
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

export const dbPricingExperimentStore: PricingExperimentStore = {
  async create(input): Promise<PricingExperiment> {
    const id = newId();
    const [row] = await db
      .insert(pricingExperiments)
      .values({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        status: "active",
        controlVariantKey: input.controlVariantKey,
        minSampleSize: input.minSampleSize,
      })
      .returning({
        id: pricingExperiments.id,
        workspaceId: pricingExperiments.workspaceId,
        name: pricingExperiments.name,
        status: pricingExperiments.status,
        controlVariantKey: pricingExperiments.controlVariantKey,
        minSampleSize: pricingExperiments.minSampleSize,
        createdAt: pricingExperiments.createdAt,
      });
    await db.insert(pricingExperimentVariants).values(
      input.variants.map((v) => ({
        experimentId: id,
        variantKey: v.key,
        planKey: v.planKey,
        label: v.label,
        weightBps: v.weightBps,
      })),
    );
    return toPricingExperiment(row!, input.variants);
  },

  async active(workspaceId: string): Promise<PricingExperiment | undefined> {
    const [row] = await db
      .select({
        id: pricingExperiments.id,
        workspaceId: pricingExperiments.workspaceId,
        name: pricingExperiments.name,
        status: pricingExperiments.status,
        controlVariantKey: pricingExperiments.controlVariantKey,
        minSampleSize: pricingExperiments.minSampleSize,
        createdAt: pricingExperiments.createdAt,
      })
      .from(pricingExperiments)
      .where(and(eq(pricingExperiments.workspaceId, workspaceId), eq(pricingExperiments.status, "active")))
      .limit(1);
    if (!row) return undefined;
    return toPricingExperiment(row, await variantsFor(row.id));
  },

  get: experimentById,

  async assignment(experimentId: string, subjectKey: string): Promise<PricingAssignment | undefined> {
    const [row] = await db
      .select()
      .from(pricingExperimentAssignments)
      .where(
        and(
          eq(pricingExperimentAssignments.experimentId, experimentId),
          eq(pricingExperimentAssignments.subjectKey, subjectKey),
        ),
      )
      .limit(1);
    return row ? toPricingAssignment(row) : undefined;
  },

  async assign(input): Promise<PricingAssignment> {
    const id = newId();
    await db
      .insert(pricingExperimentAssignments)
      .values({
        id,
        workspaceId: input.workspaceId,
        experimentId: input.experimentId,
        subjectKey: input.subjectKey,
        variantKey: input.variant.key,
        planKey: input.variant.planKey,
      })
      .onConflictDoNothing({
        target: [pricingExperimentAssignments.experimentId, pricingExperimentAssignments.subjectKey],
      });
    const existing = await this.assignment(input.experimentId, input.subjectKey);
    if (!existing) throw new Error("pricing assignment insert failed");
    return existing;
  },

  async getAssignment(workspaceId: string, assignmentId: string): Promise<PricingAssignment | undefined> {
    const [row] = await db
      .select()
      .from(pricingExperimentAssignments)
      .where(
        and(
          eq(pricingExperimentAssignments.workspaceId, workspaceId),
          eq(pricingExperimentAssignments.id, assignmentId),
        ),
      )
      .limit(1);
    return row ? toPricingAssignment(row) : undefined;
  },

  async markCheckout(workspaceId: string, assignmentId: string): Promise<void> {
    await db
      .update(pricingExperimentAssignments)
      .set({ checkoutStartedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(pricingExperimentAssignments.workspaceId, workspaceId),
          eq(pricingExperimentAssignments.id, assignmentId),
        ),
      );
  },

  async markConversion(input): Promise<void> {
    await db
      .update(pricingExperimentAssignments)
      .set({
        convertedAt: new Date(),
        revenueEventId: input.providerEventId,
        revenueCents: input.revenueCents,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pricingExperimentAssignments.workspaceId, input.workspaceId),
          eq(pricingExperimentAssignments.experimentId, input.experimentId),
          eq(pricingExperimentAssignments.id, input.assignmentId),
        ),
      );
  },

  async assignments(workspaceId: string, experimentId: string): Promise<PricingAssignment[]> {
    const rows = await db
      .select()
      .from(pricingExperimentAssignments)
      .where(
        and(
          eq(pricingExperimentAssignments.workspaceId, workspaceId),
          eq(pricingExperimentAssignments.experimentId, experimentId),
        ),
      );
    return rows.map(toPricingAssignment);
  },
};
