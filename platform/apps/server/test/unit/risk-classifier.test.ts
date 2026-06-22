import { describe, it, expect, vi } from "vitest";
import {
  classifyAndGate,
  classifyRisk,
  gateWithRisk,
  maxLevel,
  parseRiskLevel,
  riskFloor,
  RISK_LEVELS,
  type RiskClassification,
  type RiskModel,
} from "../../src/approvals/risk-classifier.js";
import { evaluatePolicy, type PolicyRule } from "../../src/approvals/policy.js";

/** A model that always returns `text`. */
const modelReturning = (text: string): RiskModel => async () => text;
/** A model that always throws — the forced classifier failure. */
const modelThrowing: RiskModel = async () => {
  throw new Error("model offline");
};
/** A model that never resolves — forces the timeout path. */
const modelHanging: RiskModel = () => new Promise<string>(() => {});

const NO_RULES: PolicyRule[] = [];

describe("parseRiskLevel", () => {
  it("accepts bare tokens, case-insensitively", () => {
    expect(parseRiskLevel("low")).toBe("low");
    expect(parseRiskLevel("MEDIUM")).toBe("medium");
    expect(parseRiskLevel("  High  ")).toBe("high");
  });

  it("accepts a JSON envelope with a level", () => {
    expect(parseRiskLevel('{"level":"high","rationale":"deletes prod data"}')).toBe("high");
    expect(parseRiskLevel('{"level":"LOW"}')).toBe("low");
  });

  it("accepts prose naming exactly one level", () => {
    expect(parseRiskLevel("Risk: high")).toBe("high");
    expect(parseRiskLevel("I'd rate this medium.")).toBe("medium");
  });

  it("returns null for garbage, empty, non-string, or conflicting output", () => {
    expect(parseRiskLevel("banana")).toBeNull();
    expect(parseRiskLevel("")).toBeNull();
    expect(parseRiskLevel("   ")).toBeNull();
    expect(parseRiskLevel("{}")).toBeNull();
    expect(parseRiskLevel("could be low or high")).toBeNull(); // conflicting → unusable
    expect(parseRiskLevel(null)).toBeNull();
    expect(parseRiskLevel(42)).toBeNull();
    expect(parseRiskLevel({ level: "high" })).toBeNull(); // object, not raw string
  });
});

describe("riskFloor", () => {
  it("floors money / publish / delete / permission actions to at least medium", () => {
    expect(riskFloor("billing.refund")).toBe("medium"); // money
    expect(riskFloor("venture.ad_spend")).toBe("medium"); // money
    expect(riskFloor("realworld.publish")).toBe("medium"); // publish
    expect(riskFloor("social.publish_post")).toBe("medium"); // publish
    expect(riskFloor("workspace.delete")).toBe("medium"); // delete
    expect(riskFloor("file.purge")).toBe("medium"); // delete-family
    expect(riskFloor("monetization.payout_settings")).toBe("medium"); // settings change
    expect(riskFloor("connection.connect_account")).toBe("medium"); // permission/grant
  });

  it("leaves ordinary sends and chat at low (model decides)", () => {
    expect(riskFloor("external.send")).toBe("low");
    expect(riskFloor("outreach.send")).toBe("low");
    expect(riskFloor("chat.post_message")).toBe("low");
    expect(riskFloor("browser.action")).toBe("low");
  });
});

describe("maxLevel", () => {
  it("returns the more dangerous level", () => {
    expect(maxLevel("low", "high")).toBe("high");
    expect(maxLevel("medium", "low")).toBe("medium");
    expect(maxLevel("medium", "high")).toBe("high");
    expect(maxLevel("low", "low")).toBe("low");
  });
});

describe("classifyRisk — fail-safe (CRITICAL #561)", () => {
  it("treats a thrown classifier error as HIGH", async () => {
    const c = await classifyRisk({ actionType: "external.send" }, { model: modelThrowing });
    expect(c.level).toBe("high");
    expect(c.failSafe).toBe(true);
    expect(c.source).toBe("fail-safe");
    expect(c.modelLevel).toBeNull();
    expect(c.rationale).toMatch(/fail-safe/i);
  });

  it("treats a classifier timeout as HIGH", async () => {
    const c = await classifyRisk({ actionType: "external.send" }, { model: modelHanging, timeoutMs: 10 });
    expect(c.level).toBe("high");
    expect(c.failSafe).toBe(true);
    expect(c.rationale).toMatch(/timed out/i);
  });

  it("treats garbage / unparseable output as HIGH", async () => {
    const c = await classifyRisk({ actionType: "external.send" }, { model: modelReturning("¯\\_(ツ)_/¯") });
    expect(c.level).toBe("high");
    expect(c.failSafe).toBe(true);
    expect(c.modelLevel).toBeNull();
  });
});

describe("classifyRisk — floor cannot be declassified by the model", () => {
  it("keeps money/publish/delete at >= medium even when the model says low", async () => {
    for (const actionType of ["billing.refund", "realworld.publish", "workspace.delete"]) {
      const c = await classifyRisk({ actionType }, { model: modelReturning("low") });
      expect(RISK_LEVELS.indexOf(c.level)).toBeGreaterThanOrEqual(RISK_LEVELS.indexOf("medium"));
      expect(c.source).toBe("floor"); // floor beat the model's low
      expect(c.modelLevel).toBe("low");
    }
  });

  it("uses the model verdict when it is at or above the floor", async () => {
    const c = await classifyRisk({ actionType: "external.send" }, { model: modelReturning("high") });
    expect(c.level).toBe("high");
    expect(c.source).toBe("model");
    expect(c.failSafe).toBe(false);
  });
});

describe("classifyRisk — no model wired", () => {
  it("returns the floor only, never a fail-safe (absence of a model is not a failure)", async () => {
    const send = await classifyRisk({ actionType: "external.send" });
    expect(send.level).toBe("low");
    expect(send.failSafe).toBe(false);
    expect(send.source).toBe("no-model");

    const refund = await classifyRisk({ actionType: "billing.refund" });
    expect(refund.level).toBe("medium");
    expect(refund.failSafe).toBe(false);
  });
});

describe("classifyRisk — observation trace (#560)", () => {
  it("emits every classification with level + rationale to the sink", async () => {
    const onClassified = vi.fn();
    await classifyRisk({ actionType: "external.send" }, { model: modelThrowing, onClassified });
    expect(onClassified).toHaveBeenCalledTimes(1);
    const record = onClassified.mock.calls[0][0] as RiskClassification & { actionType: string };
    expect(record.actionType).toBe("external.send");
    expect(record.level).toBe("high");
    expect(record.rationale).toBeTruthy();
  });
});

describe("gateWithRisk — additive, never loosens", () => {
  const low: RiskClassification = { level: "low", rationale: "x", source: "model", failSafe: false, floor: "low", modelLevel: "low" };
  const high: RiskClassification = { level: "high", rationale: "x", source: "model", failSafe: false, floor: "low", modelLevel: "high" };

  it("keeps an already-gated base verbatim even if risk is low", () => {
    const base = { requiresApproval: true, reason: "policy: gated" };
    const gated = gateWithRisk(base, low);
    expect(gated.requiresApproval).toBe(true);
    expect(gated.reason).toBe("policy: gated"); // unchanged — never declassified
  });

  it("escalates an autonomous base when risk is medium/high", () => {
    const base = { requiresApproval: false, reason: "autonomous" };
    const gated = gateWithRisk(base, high);
    expect(gated.requiresApproval).toBe(true);
    expect(gated.reason).toMatch(/risk high/);
  });

  it("leaves an autonomous base autonomous when risk is low", () => {
    const base = { requiresApproval: false, reason: "autonomous" };
    expect(gateWithRisk(base, low).requiresApproval).toBe(false);
  });
});

describe("classifyAndGate — end to end", () => {
  it("FORCED CLASSIFIER FAILURE makes a normally-autonomous action require approval (#561 acceptance)", async () => {
    // external.send is autonomous under the money-only #243 gate...
    expect(evaluatePolicy({ actionType: "external.send" }, NO_RULES).requiresApproval).toBe(false);
    // ...but with the classifier forced to fail, it MUST require human approval.
    const gated = await classifyAndGate({ actionType: "external.send" }, NO_RULES, { model: modelThrowing });
    expect(gated.requiresApproval).toBe(true);
    expect(gated.risk.level).toBe("high");
    expect(gated.risk.failSafe).toBe(true);
    expect(gated.reason).toMatch(/human approval required/);
  });

  it("a classifier timeout also forces approval", async () => {
    const gated = await classifyAndGate({ actionType: "external.send" }, NO_RULES, {
      model: modelHanging,
      timeoutMs: 10,
    });
    expect(gated.requiresApproval).toBe(true);
    expect(gated.risk.failSafe).toBe(true);
  });

  it("never loosens: a money action the model rates low still gates", async () => {
    const gated = await classifyAndGate({ actionType: "billing.refund" }, NO_RULES, { model: modelReturning("low") });
    expect(gated.requiresApproval).toBe(true); // base money gate stands
  });

  it("low-risk send with a confident low verdict stays autonomous", async () => {
    const gated = await classifyAndGate({ actionType: "external.send" }, NO_RULES, { model: modelReturning("low") });
    expect(gated.requiresApproval).toBe(false);
    expect(gated.risk.level).toBe("low");
  });

  it("with no model wired, behavior matches the existing gate (no escalation for sends)", async () => {
    const gated = await classifyAndGate({ actionType: "external.send" }, NO_RULES, {});
    expect(gated.requiresApproval).toBe(false);
    expect(gated.risk.source).toBe("no-model");
  });
});
