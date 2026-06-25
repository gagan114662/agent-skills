import { describe, expect, it } from "vitest";
import {
  TrialNurtureService,
  type TrialNurtureProfile,
  type TrialNurtureStore,
  type TrialNurtureVariantKey,
} from "../../src/billing/trial-nurture.js";

function memStore(): TrialNurtureStore {
  const rows = new Map<string, TrialNurtureProfile>();
  const key = (workspaceId: string, memberId: string) => workspaceId + "|" + memberId;
  return {
    async ensureProfile(input) {
      const k = key(input.workspaceId, input.memberId);
      const existing = rows.get(k);
      if (existing) return existing;
      const row: TrialNurtureProfile = {
        id: "trial-" + (rows.size + 1),
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        variantKey: input.variantKey,
        firstValueAt: null,
        upgradeClickedAt: null,
        paidAt: null,
        providerEventId: null,
        revenueCents: 0,
        createdAt: new Date(0),
      };
      rows.set(k, row);
      return row;
    },
    async recordSignal(input) {
      const row = rows.get(key(input.workspaceId, input.memberId));
      if (!row) throw new Error("missing profile");
      if (input.kind === "first_value") row.firstValueAt = new Date(1);
      if (input.kind === "upgrade_click") row.upgradeClickedAt = new Date(2);
      return row;
    },
    async markPaid(input) {
      const row = [...rows.values()].find((p) => p.workspaceId === input.workspaceId && !p.paidAt);
      if (!row) return;
      row.paidAt = new Date(3);
      row.providerEventId = input.providerEventId;
      row.revenueCents = input.revenueCents;
    },
    async list(workspaceId) {
      return [...rows.values()].filter((p) => p.workspaceId === workspaceId);
    },
  };
}

describe("TrialNurtureService (#607)", () => {
  it("builds A/B-testable nudges + email drafts and measures trial-to-paid", async () => {
    const service = new TrialNurtureService(memStore());
    const first = await service.plan("ws-1", "member-a");
    const again = await service.plan("ws-1", "member-a");
    expect(again.profile.variantKey).toBe(first.profile.variantKey);
    expect(["aha_first", "upgrade_moment"]).toContain(first.profile.variantKey);
    expect(first.inProductNudges[0]?.key).toBe("first-value");
    expect(first.emailDrafts).toHaveLength(2);

    await service.signal("ws-1", "member-a", "first_value", { source: "agent_task" });
    const afterAha = await service.plan("ws-1", "member-a");
    expect(afterAha.inProductNudges[0]?.key).toBe("upgrade-moment");

    await service.plan("ws-1", "member-b");
    await service.signal("ws-1", "member-a", "upgrade_click");
    await service.markPaid("ws-1", "evt_paid", 19_900);
    const summary = await service.summary("ws-1");
    expect(summary).toMatchObject({ trials: 2, paid: 1, trialToPaidRate: 0.5 });
    const variant = summary.variants.find((v) => v.variantKey === (first.profile.variantKey as TrialNurtureVariantKey))!;
    expect(variant.firstValue).toBe(1);
    expect(variant.upgradeClicks).toBe(1);
    expect(variant.revenueCents).toBe(19_900);
  });

  it("enrolls a trial signup into the first email sequence and logs each draft (#602)", async () => {
    const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
    const store = memStore();
    const originalRecordSignal = store.recordSignal.bind(store);
    store.recordSignal = async (input) => {
      events.push({ kind: input.kind, detail: input.detail });
      return originalRecordSignal(input);
    };
    const service = new TrialNurtureService(store);

    const plan = await service.enrollSignup("ws-1", "member-a", { source: "auth.signup" });

    expect(plan.emailDrafts.map((draft) => draft.key)).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(["email_draft", "email_draft"]);
    expect(events[0]?.detail).toMatchObject({
      trigger: "trial_signup",
      source: "auth.signup",
      draftKey: plan.emailDrafts[0]?.key,
      subject: plan.emailDrafts[0]?.subject,
    });
  });
});
