import { describe, it, expect } from "vitest";
import {
  planBootstrap,
  classifyMoneyBoundary,
  autonomousSteps,
  moneySteps,
} from "../../src/venture-factory/bootstrap.js";

describe("classifyMoneyBoundary (AC4 — the MONEY boundary)", () => {
  it("classes domain purchase, ad spend, and payment method as MONEY", () => {
    expect(classifyMoneyBoundary("domain_purchase")).toBe("money");
    expect(classifyMoneyBoundary("ad_spend_start")).toBe("money");
    expect(classifyMoneyBoundary("payment_method")).toBe("money");
  });

  it("classes everything else as autonomous", () => {
    for (const k of ["provision_workspace", "brand_kit", "landing_page", "repo_deploy_target", "budget_caps", "seed_fleet"] as const) {
      expect(classifyMoneyBoundary(k)).toBe("autonomous");
    }
  });
});

describe("planBootstrap (AC3 — idempotent venture bootstrap)", () => {
  it("includes a repo/deploy target only for software ventures", () => {
    const sw = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true });
    const nonSw = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: false });
    expect(sw.steps.some((s) => s.kind === "repo_deploy_target")).toBe(true);
    expect(nonSw.steps.some((s) => s.kind === "repo_deploy_target")).toBe(false);
  });

  it("omits ad spend unless explicitly requested", () => {
    expect(planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true }).steps.some((s) => s.kind === "ad_spend_start")).toBe(false);
    expect(planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true, includeAdSpend: true }).steps.some((s) => s.kind === "ad_spend_start")).toBe(true);
  });

  it("is idempotent/deterministic — same input yields identical plan + stable keys", () => {
    const a = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true });
    const b = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true });
    expect(a).toEqual(b);
    expect(a.steps.map((s) => s.idempotencyKey)).toContain("c1:provision_workspace");
  });

  it("marks money steps irreversible and the rest reversible (FM#4)", () => {
    const plan = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true, includeAdSpend: true });
    for (const s of plan.steps) {
      if (s.money === "money") expect(s.reversibility).toBe("irreversible");
      else expect(s.reversibility).toBe("reversible");
    }
  });

  it("splits autonomous (reversible, run on approval) from money (owner #13) steps", () => {
    const plan = planBootstrap({ candidateId: "c1", ventureName: "Acme", software: true, includeAdSpend: true });
    expect(autonomousSteps(plan).map((s) => s.kind)).toEqual([
      "provision_workspace",
      "brand_kit",
      "landing_page",
      "repo_deploy_target",
      "budget_caps",
      "seed_fleet",
    ]);
    expect(moneySteps(plan).map((s) => s.kind)).toEqual(["domain_purchase", "payment_method", "ad_spend_start"]);
  });
});
