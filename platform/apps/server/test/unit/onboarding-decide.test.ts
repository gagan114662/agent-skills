import { describe, it, expect } from "vitest";
import {
  classifyReversibility,
  REVERSIBILITY_BY_KIND,
  toSetupRequestSpec,
  buildSetupSummary,
  decideSetupNeeded,
  shouldParkForSetup,
  decideCapabilityStates,
  decideRotationReminders,
} from "../../src/onboarding/decide.js";
import type { RequiredService } from "../../src/onboarding/types.js";

const esp: RequiredService = {
  serviceKey: "sendgrid",
  serviceKind: "esp",
  displayName: "SendGrid",
  plan: "Pro",
  scopes: ["mail.send"],
  reason: "transactional email for the launch",
  projectedCostCents: 1500,
  envKeys: ["SENDGRID_API_KEY"],
};

const registrar: RequiredService = {
  serviceKey: "namecheap",
  serviceKind: "registrar",
  displayName: "Namecheap",
  reason: "buy launch.example.com",
  projectedCostCents: 1200,
};

describe("classifyReversibility", () => {
  it("treats a registrar (domain purchase) as irreversible — a money decision", () => {
    expect(classifyReversibility("registrar", 1200)).toBe("irreversible");
    expect(classifyReversibility("registrar", 0)).toBe("irreversible");
  });

  it("treats a payment account as irreversible", () => {
    expect(classifyReversibility("payment", 0)).toBe("irreversible");
  });

  it("escalates a free reversible service to cheap once it carries recurring cost", () => {
    expect(classifyReversibility("esp", 0)).toBe("reversible");
    expect(classifyReversibility("esp", 1500)).toBe("cheap");
  });

  it("keeps hosting/ad accounts cheap", () => {
    expect(classifyReversibility("hosting", 0)).toBe("cheap");
    expect(classifyReversibility("ad_account", 5000)).toBe("cheap");
  });

  it("has an entry for every service kind", () => {
    expect(Object.keys(REVERSIBILITY_BY_KIND).sort()).toEqual(
      ["ad_account", "analytics", "esp", "hosting", "other", "payment", "registrar", "sms"].sort(),
    );
  });
});

describe("toSetupRequestSpec", () => {
  it("carries which service/plan/scopes/why/cost and always requires a human", () => {
    const spec = toSetupRequestSpec(esp);
    expect(spec.serviceKey).toBe("sendgrid");
    expect(spec.plan).toBe("Pro");
    expect(spec.scopes).toEqual(["mail.send"]);
    expect(spec.reason).toBe("transactional email for the launch");
    expect(spec.projectedCostCents).toBe(1500);
    expect(spec.reversibility).toBe("cheap");
    expect(spec.requiresHuman).toBe(true); // agents never create accounts / paste keys
    expect(spec.envKeys).toEqual(["SENDGRID_API_KEY"]);
    expect(spec.summary).toContain("SendGrid");
    expect(spec.summary).toContain("$15.00");
  });

  it("clamps a negative/fractional cost and defaults missing optionals", () => {
    const spec = toSetupRequestSpec({
      serviceKey: "ga",
      serviceKind: "analytics",
      displayName: "GA4",
      reason: "track signups",
      projectedCostCents: -10,
    });
    expect(spec.projectedCostCents).toBe(0);
    expect(spec.plan).toBeNull();
    expect(spec.scopes).toEqual([]);
    expect(spec.envKeys).toEqual([]);
    expect(spec.reversibility).toBe("reversible");
  });
});

describe("buildSetupSummary", () => {
  it("says (no cost) when the projected cost is zero", () => {
    const s = buildSetupSummary({
      displayName: "GA4",
      serviceKind: "analytics",
      plan: null,
      projectedCostCents: 0,
      reason: "track signups",
    });
    expect(s).toContain("(no cost)");
    expect(s).toContain("track signups");
  });
});

describe("decideSetupNeeded", () => {
  it("files a request only for services not already connected", () => {
    const specs = decideSetupNeeded([esp, registrar], new Set(["sendgrid"]));
    expect(specs.map((s) => s.serviceKey)).toEqual(["namecheap"]);
  });

  it("dedupes duplicate declarations of the same service", () => {
    const specs = decideSetupNeeded([esp, esp], new Set());
    expect(specs).toHaveLength(1);
  });

  it("returns empty when everything is connected", () => {
    expect(decideSetupNeeded([esp], new Set(["sendgrid"]))).toEqual([]);
  });
});

describe("shouldParkForSetup", () => {
  it("parks when a required service is missing and not when all are connected", () => {
    expect(shouldParkForSetup([esp, registrar], new Set(["sendgrid"]))).toBe(true);
    expect(shouldParkForSetup([esp], new Set(["sendgrid"]))).toBe(false);
    expect(shouldParkForSetup([], new Set())).toBe(false);
  });
});

describe("decideCapabilityStates", () => {
  const deps = [
    { capability: "email_send", requiredServiceKeys: ["sendgrid"] },
    { capability: "paid_ads", requiredServiceKeys: ["google_ads", "stripe"] },
  ];

  it("marks a capability online only when every dependency is connected", () => {
    const states = decideCapabilityStates(deps, new Set(["sendgrid", "google_ads"]));
    const email = states.find((s) => s.capability === "email_send")!;
    const ads = states.find((s) => s.capability === "paid_ads")!;
    expect(email.online).toBe(true);
    expect(email.missingServices).toEqual([]);
    expect(ads.online).toBe(false);
    expect(ads.missingServices).toEqual(["stripe"]);
    expect(ads.reason).toContain("stripe");
  });

  it("takes a capability offline when its credential is revoked (key removed from the set)", () => {
    const before = decideCapabilityStates(deps, new Set(["sendgrid"]));
    expect(before.find((s) => s.capability === "email_send")!.online).toBe(true);
    const after = decideCapabilityStates(deps, new Set()); // sendgrid revoked
    expect(after.find((s) => s.capability === "email_send")!.online).toBe(false);
  });
});

describe("decideRotationReminders", () => {
  const now = 100 * 86_400_000; // day 100

  it("reminds only credentials past their rotation age", () => {
    const reminders = decideRotationReminders(
      [
        { serviceKey: "old", connectedAtMs: 0, rotationReminderDays: 90 }, // age 100 > 90 → due
        { serviceKey: "fresh", connectedAtMs: 95 * 86_400_000, rotationReminderDays: 90 }, // age 5 → not due
        { serviceKey: "never", connectedAtMs: 0, rotationReminderDays: 0 }, // disabled
      ],
      now,
    );
    expect(reminders.map((r) => r.serviceKey)).toEqual(["old"]);
    expect(reminders[0].ageDays).toBe(100);
    expect(reminders[0].overdueDays).toBe(10);
    expect(reminders[0].dueInDays).toBe(-10);
  });

  it("returns nothing when no reminders are configured", () => {
    expect(decideRotationReminders([], now)).toEqual([]);
  });
});
