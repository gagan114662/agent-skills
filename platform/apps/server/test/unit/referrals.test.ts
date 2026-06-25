import { describe, expect, it } from "vitest";
import { InMemoryReferralStore, ReferralService } from "../../src/referrals/service.js";

describe("ReferralService (#603)", () => {
  it("attributes a referred signup and fulfills auditable give/get incentives", async () => {
    const service = new ReferralService(new InMemoryReferralStore(), {
      referrerCreditCents: 4_900,
      referredCreditCents: 1_000,
    });
    const code = await service.ensureWorkspaceReferralCode("w-referrer", "m-referrer");

    const audit = await service.attributeSignup({
      referralCode: code.code,
      referredWorkspaceId: "w-referred",
      referredMemberId: "m-referred",
      trackingRef: "trk_signup",
    });

    expect(audit?.signup).toMatchObject({
      referrerWorkspaceId: "w-referrer",
      referredWorkspaceId: "w-referred",
      referredMemberId: "m-referred",
      trackingRef: "trk_signup",
    });
    expect(audit?.incentives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: "w-referrer", kind: "referrer_credit", amountCents: 4_900, status: "fulfilled" }),
        expect.objectContaining({ workspaceId: "w-referred", kind: "referred_credit", amountCents: 1_000, status: "fulfilled" }),
      ]),
    );
    await expect(service.listAudit("w-referrer")).resolves.toHaveLength(1);
  });

  it("does not self-attribute when a workspace signs up with its own referral code", async () => {
    const service = new ReferralService(new InMemoryReferralStore());
    const code = await service.ensureWorkspaceReferralCode("w-self", "m-self");

    await expect(
      service.attributeSignup({
        referralCode: code.code,
        referredWorkspaceId: "w-self",
        referredMemberId: "m-self",
        trackingRef: null,
      }),
    ).resolves.toBeNull();
  });
});
