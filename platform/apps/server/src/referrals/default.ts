import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { referralCodes, referralIncentives, referralSignups } from "../db/schema/index.js";
import {
  ReferralService,
  type ReferralAudit,
  type ReferralCodeRecord,
  type ReferralIncentiveKind,
  type ReferralIncentiveRecord,
  type ReferralSignupRecord,
  type ReferralStore,
} from "./service.js";

function codeRow(row: typeof referralCodes.$inferSelect): ReferralCodeRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerMemberId: row.ownerMemberId,
    code: row.code,
    createdAt: row.createdAt,
  };
}

function signupRow(row: typeof referralSignups.$inferSelect): ReferralSignupRecord {
  return {
    id: row.id,
    referralCodeId: row.referralCodeId,
    referrerWorkspaceId: row.referrerWorkspaceId,
    referredWorkspaceId: row.referredWorkspaceId,
    referredMemberId: row.referredMemberId,
    trackingRef: row.trackingRef,
    occurredAt: row.occurredAt,
  };
}

function incentiveRow(row: typeof referralIncentives.$inferSelect): ReferralIncentiveRecord {
  return {
    id: row.id,
    referralSignupId: row.referralSignupId,
    workspaceId: row.workspaceId,
    kind: row.kind as ReferralIncentiveKind,
    status: "fulfilled",
    amountCents: row.amountCents,
    reason: row.reason,
    createdAt: row.createdAt,
    fulfilledAt: row.fulfilledAt,
  };
}

export const dbReferralStore: ReferralStore = {
  async getActiveCodeForWorkspace(workspaceId) {
    const [row] = await db.select().from(referralCodes).where(eq(referralCodes.workspaceId, workspaceId)).limit(1);
    return row ? codeRow(row) : null;
  },

  async getCode(code) {
    const [row] = await db.select().from(referralCodes).where(eq(referralCodes.code, code)).limit(1);
    return row ? codeRow(row) : null;
  },

  async createCode(input) {
    const [row] = await db
      .insert(referralCodes)
      .values(input)
      .onConflictDoNothing()
      .returning();
    if (row) return codeRow(row);
    const [existing] = await db.select().from(referralCodes).where(eq(referralCodes.workspaceId, input.workspaceId)).limit(1);
    if (!existing) throw new Error("referral code collision");
    return codeRow(existing);
  },

  async recordSignup(input) {
    const [row] = await db
      .insert(referralSignups)
      .values({
        referralCodeId: input.referralCode.id,
        referrerWorkspaceId: input.referralCode.workspaceId,
        referredWorkspaceId: input.referredWorkspaceId,
        referredMemberId: input.referredMemberId,
        trackingRef: input.trackingRef,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return signupRow(row);
    const [existing] = await db
      .select()
      .from(referralSignups)
      .where(eq(referralSignups.referredWorkspaceId, input.referredWorkspaceId))
      .limit(1);
    if (!existing) throw new Error("referral signup collision");
    return signupRow(existing);
  },

  async fulfillIncentive(input) {
    const now = new Date();
    const [row] = await db
      .insert(referralIncentives)
      .values({ ...input, status: "fulfilled", fulfilledAt: now })
      .onConflictDoNothing()
      .returning();
    if (row) return incentiveRow(row);
    const [existing] = await db
      .select()
      .from(referralIncentives)
      .where(
        and(
          eq(referralIncentives.referralSignupId, input.referralSignupId),
          eq(referralIncentives.workspaceId, input.workspaceId),
          eq(referralIncentives.kind, input.kind),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("referral incentive collision");
    return incentiveRow(existing);
  },

  async listAudit(workspaceId): Promise<ReferralAudit[]> {
    const signups = await db
      .select()
      .from(referralSignups)
      .where(or(eq(referralSignups.referrerWorkspaceId, workspaceId), eq(referralSignups.referredWorkspaceId, workspaceId)))
      .orderBy(desc(referralSignups.occurredAt));
    const audits: ReferralAudit[] = [];
    for (const signup of signups) {
      const incentives = await db
        .select()
        .from(referralIncentives)
        .where(eq(referralIncentives.referralSignupId, signup.id))
        .orderBy(desc(referralIncentives.createdAt));
      audits.push({ signup: signupRow(signup), incentives: incentives.map(incentiveRow) });
    }
    return audits;
  },
};

export function createDefaultReferralService(): ReferralService {
  return new ReferralService(dbReferralStore);
}
