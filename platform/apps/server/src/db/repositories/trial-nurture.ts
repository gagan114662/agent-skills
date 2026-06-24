import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../index.js";
import { newId } from "../id.js";
import { trialNurtureEvents, trialNurtureProfiles } from "../schema/index.js";
import type {
  TrialNurtureProfile,
  TrialNurtureSignalKind,
  TrialNurtureStore,
  TrialNurtureVariantKey,
} from "../../billing/trial-nurture.js";

function toProfile(row: typeof trialNurtureProfiles.$inferSelect): TrialNurtureProfile {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    memberId: row.memberId,
    variantKey: row.variantKey as TrialNurtureVariantKey,
    firstValueAt: row.firstValueAt,
    upgradeClickedAt: row.upgradeClickedAt,
    paidAt: row.paidAt,
    providerEventId: row.providerEventId,
    revenueCents: row.revenueCents,
    createdAt: row.createdAt,
  };
}

async function findProfile(workspaceId: string, memberId: string): Promise<TrialNurtureProfile | undefined> {
  const [row] = await db
    .select()
    .from(trialNurtureProfiles)
    .where(and(eq(trialNurtureProfiles.workspaceId, workspaceId), eq(trialNurtureProfiles.memberId, memberId)))
    .limit(1);
  return row ? toProfile(row) : undefined;
}

export const dbTrialNurtureStore: TrialNurtureStore = {
  async ensureProfile(input): Promise<TrialNurtureProfile> {
    await db
      .insert(trialNurtureProfiles)
      .values({
        id: newId(),
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        variantKey: input.variantKey,
      })
      .onConflictDoNothing({
        target: [trialNurtureProfiles.workspaceId, trialNurtureProfiles.memberId],
      });
    const profile = await findProfile(input.workspaceId, input.memberId);
    if (!profile) throw new Error("trial nurture profile insert failed");
    return profile;
  },

  async recordSignal(input): Promise<TrialNurtureProfile> {
    const profile = await findProfile(input.workspaceId, input.memberId);
    if (!profile) throw new Error("trial nurture profile not found");
    await db.insert(trialNurtureEvents).values({
      id: newId(),
      profileId: profile.id,
      kind: input.kind,
      detail: input.detail ?? {},
    });
    const updates: Partial<typeof trialNurtureProfiles.$inferInsert> = { updatedAt: new Date() };
    if (input.kind === "first_value" && !profile.firstValueAt) updates.firstValueAt = new Date();
    if (input.kind === "upgrade_click" && !profile.upgradeClickedAt) updates.upgradeClickedAt = new Date();
    if (Object.keys(updates).length > 1) {
      await db
        .update(trialNurtureProfiles)
        .set(updates)
        .where(eq(trialNurtureProfiles.id, profile.id));
    }
    const updated = await findProfile(input.workspaceId, input.memberId);
    return updated ?? profile;
  },

  async markPaid(input): Promise<void> {
    const [profile] = await db
      .select()
      .from(trialNurtureProfiles)
      .where(and(eq(trialNurtureProfiles.workspaceId, input.workspaceId), isNull(trialNurtureProfiles.paidAt)))
      .orderBy(asc(trialNurtureProfiles.createdAt))
      .limit(1);
    if (!profile) return;
    await db
      .update(trialNurtureProfiles)
      .set({
        paidAt: new Date(),
        providerEventId: input.providerEventId,
        revenueCents: input.revenueCents,
        updatedAt: new Date(),
      })
      .where(eq(trialNurtureProfiles.id, profile.id));
    await db.insert(trialNurtureEvents).values({
      id: newId(),
      profileId: profile.id,
      kind: "paid" satisfies TrialNurtureSignalKind,
      detail: { providerEventId: input.providerEventId, revenueCents: input.revenueCents },
    });
  },

  async list(workspaceId: string): Promise<TrialNurtureProfile[]> {
    const rows = await db
      .select()
      .from(trialNurtureProfiles)
      .where(eq(trialNurtureProfiles.workspaceId, workspaceId));
    return rows.map(toProfile);
  },
};
