import { describe, it, expect } from "vitest";
import { GatePricingService, type GatePricingDeps } from "../../src/gate-pricing/service.js";
import { GATE_PRICING_DEFAULTS, type GatePricingCaps } from "../../src/gate-pricing/caps.js";
import type { Outcome } from "../../src/gate-pricing/pricing.js";

const ON: GatePricingCaps = { ...GATE_PRICING_DEFAULTS, enabled: true };

interface Recorded {
  relaxed: { actionType: string }[];
  retightened: { ruleId: string }[];
  audited: { actionType: string; direction: string; errorRate: number; policyRuleId: string | null }[];
}

/** Build a service over fakes; `evidence` maps action class → its window outcomes (newest-first). */
function build(opts: {
  caps?: GatePricingCaps;
  evidence: Record<string, Outcome[]>;
  relaxedRules?: Record<string, string>; // actionType → existing rule id (a relaxed boundary)
}): { svc: GatePricingService; rec: Recorded } {
  const rec: Recorded = { relaxed: [], retightened: [], audited: [] };
  const relaxedRules = { ...(opts.relaxedRules ?? {}) };
  let nextId = 1;
  const deps: GatePricingDeps = {
    caps: () => opts.caps ?? ON,
    listActionTypes: async () => Object.keys(opts.evidence),
    readWindow: async (_ws, actionType, limit) => (opts.evidence[actionType] ?? []).slice(0, limit),
    currentlyRelaxed: async (_ws, actionType) => ({
      relaxed: actionType in relaxedRules,
      ruleId: relaxedRules[actionType] ?? null,
    }),
    relax: async (_ws, actionType) => {
      const id = `rule-${nextId++}`;
      relaxedRules[actionType] = id;
      rec.relaxed.push({ actionType });
      return id;
    },
    retighten: async (_ws, ruleId) => {
      rec.retightened.push({ ruleId });
    },
    audit: async (c) => {
      rec.audited.push({
        actionType: c.actionType,
        direction: c.direction,
        errorRate: c.errorRate,
        policyRuleId: c.policyRuleId,
      });
    },
  };
  return { svc: new GatePricingService(deps), rec };
}

const approvals = (n: number): Outcome[] => Array<Outcome>(n).fill("approved");

describe("GatePricingService.tick", () => {
  it("does nothing when the pricer is disabled (default-OFF)", async () => {
    const { svc, rec } = build({
      caps: GATE_PRICING_DEFAULTS, // enabled: false
      evidence: { "chat.post_message": approvals(100) },
    });
    expect(await svc.tick("ws")).toEqual([]);
    expect(rec.relaxed).toEqual([]);
    expect(rec.audited).toEqual([]);
  });

  it("RELAXes a clean reversible class and writes the audit row with the earning error rate", async () => {
    const { svc, rec } = build({ evidence: { "chat.post_message": approvals(100) } });
    const applied = await svc.tick("ws");

    expect(applied).toHaveLength(1);
    expect(applied[0].decision.recommendation).toBe("RELAX");
    expect(rec.relaxed).toEqual([{ actionType: "chat.post_message" }]);
    expect(rec.audited).toEqual([
      { actionType: "chat.post_message", direction: "RELAX", errorRate: 0, policyRuleId: "rule-1" },
    ]);
  });

  it("RE-TIGHTENs a relaxed class whose error rate climbed, revoking its rule", async () => {
    const window: Outcome[] = [...Array<Outcome>(20).fill("edited"), ...approvals(80)]; // 0.20 error
    const { svc, rec } = build({
      evidence: { "chat.post_message": window },
      relaxedRules: { "chat.post_message": "rule-existing" },
    });
    const applied = await svc.tick("ws");

    expect(applied).toHaveLength(1);
    expect(applied[0].decision.recommendation).toBe("RETIGHTEN");
    expect(rec.retightened).toEqual([{ ruleId: "rule-existing" }]);
    expect(rec.audited[0]).toMatchObject({ direction: "RETIGHTEN", policyRuleId: "rule-existing" });
  });

  it("NEVER relaxes an invariant class even with a perfect window", async () => {
    const { svc, rec } = build({ evidence: { "billing.payout": approvals(1000) } });
    const applied = await svc.tick("ws");
    expect(applied).toEqual([]);
    expect(rec.relaxed).toEqual([]);
    expect(rec.audited).toEqual([]);
  });

  it("RE-TIGHTENs an invariant class that is somehow found relaxed (defense in depth)", async () => {
    const { svc, rec } = build({
      evidence: { "external.send": approvals(1000) },
      relaxedRules: { "external.send": "stray-rule" },
    });
    await svc.tick("ws");
    expect(rec.retightened).toEqual([{ ruleId: "stray-rule" }]);
    expect(rec.audited[0]).toMatchObject({ actionType: "external.send", direction: "RETIGHTEN" });
  });

  it("HOLDs (no side effects) when error sits in the hysteresis dead band", async () => {
    const window: Outcome[] = [...Array<Outcome>(10).fill("edited"), ...approvals(90)]; // 0.10
    const { svc, rec } = build({
      evidence: { "chat.post_message": window },
      relaxedRules: { "chat.post_message": "rule-x" },
    });
    expect(await svc.tick("ws")).toEqual([]);
    expect(rec.retightened).toEqual([]);
    expect(rec.relaxed).toEqual([]);
  });
});
