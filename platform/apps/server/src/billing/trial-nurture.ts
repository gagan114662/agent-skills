export type TrialNurtureVariantKey = "aha_first" | "upgrade_moment";
export type TrialNurtureSignalKind = "nudge_view" | "email_draft" | "first_value" | "upgrade_click" | "paid";

export interface TrialNurtureProfile {
  id: string;
  workspaceId: string;
  memberId: string;
  variantKey: TrialNurtureVariantKey;
  firstValueAt: Date | null;
  upgradeClickedAt: Date | null;
  paidAt: Date | null;
  providerEventId: string | null;
  revenueCents: number;
  createdAt: Date;
}

export interface TrialNurtureStore {
  ensureProfile(input: {
    workspaceId: string;
    memberId: string;
    variantKey: TrialNurtureVariantKey;
  }): Promise<TrialNurtureProfile>;
  recordSignal(input: {
    workspaceId: string;
    memberId: string;
    kind: TrialNurtureSignalKind;
    detail?: Record<string, unknown>;
  }): Promise<TrialNurtureProfile>;
  markPaid(input: { workspaceId: string; providerEventId: string; revenueCents: number }): Promise<void>;
  list(workspaceId: string): Promise<TrialNurtureProfile[]>;
}

export interface TrialNurturePlan {
  profile: TrialNurtureProfile;
  inProductNudges: Array<{ key: string; title: string; body: string; cta: string }>;
  emailDrafts: Array<{ key: string; subject: string; body: string }>;
}

export interface TrialNurtureSummary {
  workspaceId: string;
  trials: number;
  paid: number;
  trialToPaidRate: number;
  variants: Array<{
    variantKey: TrialNurtureVariantKey;
    trials: number;
    firstValue: number;
    upgradeClicks: number;
    paid: number;
    revenueCents: number;
    trialToPaidRate: number;
  }>;
}

export class TrialNurtureService {
  constructor(private readonly store: TrialNurtureStore) {}

  async plan(workspaceId: string, memberId: string): Promise<TrialNurturePlan> {
    const profile = await this.store.ensureProfile({
      workspaceId,
      memberId,
      variantKey: assignVariant(memberId),
    });
    return buildPlan(profile);
  }

  async signal(
    workspaceId: string,
    memberId: string,
    kind: Exclude<TrialNurtureSignalKind, "paid">,
    detail: Record<string, unknown> = {},
  ): Promise<TrialNurtureProfile> {
    await this.store.ensureProfile({
      workspaceId,
      memberId,
      variantKey: assignVariant(memberId),
    });
    return this.store.recordSignal({ workspaceId, memberId, kind, detail });
  }

  markPaid(workspaceId: string, providerEventId: string, revenueCents: number): Promise<void> {
    return this.store.markPaid({ workspaceId, providerEventId, revenueCents });
  }

  async summary(workspaceId: string): Promise<TrialNurtureSummary> {
    const profiles = await this.store.list(workspaceId);
    const variants: TrialNurtureSummary["variants"] = (["aha_first", "upgrade_moment"] as const).map((variantKey) => {
      const rows = profiles.filter((p) => p.variantKey === variantKey);
      const paid = rows.filter((p) => p.paidAt).length;
      return {
        variantKey,
        trials: rows.length,
        firstValue: rows.filter((p) => p.firstValueAt).length,
        upgradeClicks: rows.filter((p) => p.upgradeClickedAt).length,
        paid,
        revenueCents: rows.reduce((sum, p) => sum + p.revenueCents, 0),
        trialToPaidRate: rate(paid, rows.length),
      };
    });
    const paid = profiles.filter((p) => p.paidAt).length;
    return {
      workspaceId,
      trials: profiles.length,
      paid,
      trialToPaidRate: rate(paid, profiles.length),
      variants,
    };
  }
}

function buildPlan(profile: TrialNurtureProfile): TrialNurturePlan {
  const needsAha = !profile.firstValueAt;
  const upgradeReady = Boolean(profile.firstValueAt && !profile.paidAt);
  const inProductNudges = needsAha
    ? [
        {
          key: "first-value",
          title: "Ship one useful thing",
          body: "Start by launching a single agent task with a concrete outcome. That is the fastest path to the aha.",
          cta: "Run first agent task",
        },
      ]
    : [
        {
          key: "upgrade-moment",
          title: "Keep the momentum",
          body: "You have seen first value. Upgrade when you are ready to make this an always-on workflow.",
          cta: "Upgrade plan",
        },
      ];
  const emailDrafts =
    profile.variantKey === "aha_first"
      ? [
          {
            key: "aha-day-1",
            subject: "Your first agent win is the whole game",
            body: "Pick one task, ship it, and use the result as your upgrade signal.",
          },
          {
            key: "aha-day-3",
            subject: "Turn that first result into a repeatable workflow",
            body: upgradeReady
              ? "You reached first value. The paid plan is for making that win happen again without babysitting it."
              : "Your next best move is one small task with visible output. After that, paying has a real reason.",
          },
        ]
      : [
          {
            key: "upgrade-day-1",
            subject: "When the trial clicks, make it permanent",
            body: "Use the trial to prove one workflow. Upgrade once the saved time is obvious.",
          },
          {
            key: "upgrade-day-3",
            subject: "The right time to pay is after first value",
            body: upgradeReady
              ? "You have a result worth keeping. Upgrade to keep the agents running with more capacity."
              : "Get to one visible result first; the upgrade prompt will make more sense after that.",
          },
        ];
  return { profile, inProductNudges, emailDrafts };
}

function assignVariant(memberId: string): TrialNurtureVariantKey {
  return stableBucket(memberId) % 2 === 0 ? "aha_first" : "upgrade_moment";
}

function stableBucket(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function rate(num: number, denom: number): number {
  return denom > 0 ? num / denom : 0;
}
