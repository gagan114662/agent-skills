import { describe, it, expect } from "vitest";
import {
  ALWAYS_ON_GUARDS,
  AUTONOMY_DEFAULTS_ALL_ON,
  CAPABILITIES,
  CHANNELS,
  classifyMoney,
  decideAutonomy,
  decideAutonomyFromEnv,
  inferCapability,
  isAlwaysOnGuard,
  isMoneyAction,
  requiresApproval,
  resolveAutonomyCaps,
} from "../../src/autonomy-defaults/index.js";

const FRESH = resolveAutonomyCaps({}); // a fresh workspace: no env set

describe("autonomy-defaults/money — classifyMoney (the one hard gate, #727)", () => {
  it("flags unambiguous money-movement verbs", () => {
    for (const a of [
      "stripe.charge",
      "billing.refund",
      "payouts.create",
      "wallet.withdraw",
      "vendor.pay",
      "invoice.checkout",
    ]) {
      expect(isMoneyAction({ action: a })).toBe(true);
    }
  });

  it("flags real ad spend and connecting a live payment key", () => {
    expect(isMoneyAction({ action: "post.publish", paidAdSpend: true })).toBe(true);
    expect(isMoneyAction({ action: "ads.launch", surface: "google.ads.budget" })).toBe(true);
    expect(isMoneyAction({ action: "settings.update", connectsLivePaymentKey: true })).toBe(true);
    expect(
      isMoneyAction({ action: "stripe.connect", surface: "payments", payload: { mode: "live" } }),
    ).toBe(true);
    // explicit escape hatch for an ambiguous money verb
    expect(isMoneyAction({ action: "ledger.transfer", money: true })).toBe(true);
  });

  it("does NOT flag drafts, publishing, non-paid outreach, deploys, or money-free deletes", () => {
    for (const a of [
      "blog.draft",
      "post.compose",
      "blog.publish",
      "social.post",
      "email.send",
      "sms.send",
      "deploy",
      "release.ship",
      "record.delete",
      "campaign.connect", // connect WITHOUT a live payment key + payment surface
    ]) {
      expect(classifyMoney({ action: a }).isMoney).toBe(false);
    }
  });

  it("a connect to a payment surface without a live marker is NOT money (test-mode is free)", () => {
    expect(isMoneyAction({ action: "stripe.connect", surface: "payments" })).toBe(false);
    expect(isMoneyAction({ action: "stripe.connect", surface: "payments", payload: { mode: "test" } })).toBe(false);
  });
});

describe("autonomy-defaults/policy — money gated, everything else autonomous by default (#727 acceptance)", () => {
  it("a fresh workspace gates ONLY money; drafts/publishing/non-paid outreach/deploys are autonomous", () => {
    // money → gated
    expect(decideAutonomy({ action: "stripe.charge" }, FRESH).mode).toBe("gated");
    expect(decideAutonomy({ action: "stripe.charge" }, FRESH).gate).toBe("money");

    // everything else → autonomous
    for (const a of [
      "blog.draft",
      "post.compose",
      "blog.publish",
      "social.post",
      "email.send",
      "deploy",
      "release.ship",
      "record.delete", // irreversible-but-money-free still autonomous (the whole point)
    ]) {
      const d = decideAutonomy({ action: a }, FRESH);
      expect(d.mode, `${a} should be autonomous`).toBe("autonomous");
      expect(d.gate).toBe("none");
    }
  });

  it("infers the capability from the verb", () => {
    expect(inferCapability("blog.draft")).toBe("draft");
    expect(inferCapability("blog.publish")).toBe("publish");
    expect(inferCapability("email.send")).toBe("outreach");
    expect(inferCapability("service.deploy")).toBe("deploy");
    expect(inferCapability("widget.frobnicate")).toBeNull();
  });
});

describe("autonomy-defaults/policy — per-capability and per-channel opt-OUT (default ON, dial down)", () => {
  it("disabling one capability gates only that capability; the rest stay autonomous", () => {
    const caps = resolveAutonomyCaps({ AUTONOMY_DISABLE_CAPABILITIES: "publish" });
    const pub = decideAutonomy({ action: "blog.publish" }, caps);
    expect(pub.mode).toBe("gated");
    expect(pub.gate).toBe("capability_disabled");
    // a different capability is unaffected
    expect(decideAutonomy({ action: "email.send" }, caps).mode).toBe("autonomous");
  });

  it("disabling one channel gates only sends on that channel", () => {
    const caps = resolveAutonomyCaps({ AUTONOMY_DISABLE_CHANNELS: "email" });
    const viaEmail = decideAutonomy({ action: "outreach.send", channel: "email" }, caps);
    expect(viaEmail.mode).toBe("gated");
    expect(viaEmail.gate).toBe("channel_disabled");
    // another channel still autonomous
    expect(decideAutonomy({ action: "outreach.send", channel: "sms" }, caps).mode).toBe("autonomous");
  });

  it("accepts comma/space lists and ignores unknown names", () => {
    const caps = resolveAutonomyCaps({ AUTONOMY_DISABLE_CAPABILITIES: "publish, deploy nonsense" });
    expect(caps.capabilities.publish).toBe(false);
    expect(caps.capabilities.deploy).toBe(false);
    expect(caps.capabilities.draft).toBe(true);
    expect(caps.capabilities.outreach).toBe(true);
  });
});

describe("autonomy-defaults — money is the ONLY hard gate and cannot be dialed off", () => {
  it("no env turns a money action autonomous (money is not in the opt-out set)", () => {
    const trying = resolveAutonomyCaps({
      AUTONOMY_DISABLE_CAPABILITIES: "money,charge,payout,publish,outreach,deploy,draft",
      AUTONOMY_DISABLE_CHANNELS: "email,sms,social,slack,dm,voice,push,web",
    });
    // even with everything someone could think to disable, a money action is still gated as money
    const d = decideAutonomy({ action: "stripe.charge" }, trying);
    expect(d.mode).toBe("gated");
    expect(d.gate).toBe("money");
    expect(decideAutonomyFromEnv({ action: "billing.refund" }, {}).gate).toBe("money");
  });

  it("dialing a capability off can only ADD gating, never relax money", () => {
    // disabling 'publish' must not make a paid-ad publish autonomous — it is still money
    const caps = resolveAutonomyCaps({ AUTONOMY_DISABLE_CAPABILITIES: "publish" });
    const paidPublish = decideAutonomy({ action: "blog.publish", paidAdSpend: true }, caps);
    expect(paidPublish.mode).toBe("gated");
    expect(paidPublish.gate).toBe("money"); // money wins over capability_disabled
  });
});

describe("autonomy-defaults — fresh-workspace defaults are all ON (zero switch-flipping)", () => {
  it("resolveAutonomyCaps with no env enables every capability and channel", () => {
    expect(FRESH).toEqual(AUTONOMY_DEFAULTS_ALL_ON);
    expect(Object.values(FRESH.capabilities).every((v) => v === true)).toBe(true);
    expect(Object.values(FRESH.channels).every((v) => v === true)).toBe(true);
    expect(Object.keys(FRESH.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    expect(Object.keys(FRESH.channels).sort()).toEqual([...CHANNELS].sort());
  });

  it("requiresApproval is true only for money on a fresh workspace", () => {
    expect(requiresApproval({ action: "stripe.charge" }, FRESH)).toBe(true);
    expect(requiresApproval({ action: "blog.publish" }, FRESH)).toBe(false);
    expect(requiresApproval({ action: "email.send", channel: "email" }, FRESH)).toBe(false);
  });
});

describe("autonomy-defaults — always-on guards stay on and are not toggleable", () => {
  it("names the kill-switch, suppression/opt-out, and anti-injection as always on", () => {
    expect([...ALWAYS_ON_GUARDS]).toEqual(["kill_switch", "suppression_opt_out", "anti_injection"]);
    for (const g of ALWAYS_ON_GUARDS) expect(isAlwaysOnGuard(g)).toBe(true);
    expect(isAlwaysOnGuard("publish")).toBe(false);
  });

  it("an always-on guard is never one of the opt-out capability/channel toggles", () => {
    for (const g of ALWAYS_ON_GUARDS) {
      expect((CAPABILITIES as readonly string[]).includes(g)).toBe(false);
      expect((CHANNELS as readonly string[]).includes(g)).toBe(false);
    }
  });
});
