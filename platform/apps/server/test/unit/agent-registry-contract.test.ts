import { describe, it, expect } from "vitest";
import {
  agentContracts,
  buildAgentContract,
  contractForHandle,
  handleHasCapability,
  isExternalSendRisk,
  isFleetHandle,
  COST_TIERS,
  RISK_TIERS,
} from "../../src/agent-registry/contract.js";
import { MARKETING_DEPARTMENTS } from "../../src/marketing/blueprint.js";

const FLEET_HANDLES = ["scout", "echo", "quill", "postmark", "bid", "lens", "mark", "comet"];

describe("agent-registry/contract — derivation from the blueprint", () => {
  it("produces exactly one contract per blueprint department, in order", () => {
    const contracts = agentContracts();
    expect(contracts).toHaveLength(MARKETING_DEPARTMENTS.length);
    expect(contracts.map((c) => c.handle)).toEqual(MARKETING_DEPARTMENTS.map((d) => d.agent.handle));
  });

  it("covers every known fleet handle", () => {
    expect(agentContracts().map((c) => c.handle).sort()).toEqual([...FLEET_HANDLES].sort());
  });

  it("carries the blueprint's tools, displayName, department and intro verbatim (single source of truth)", () => {
    for (const dept of MARKETING_DEPARTMENTS) {
      const c = buildAgentContract(dept);
      expect(c.tools).toEqual([...dept.agent.allowedTools]);
      expect(c.displayName).toBe(dept.agent.displayName);
      expect(c.department).toBe(dept.key);
      expect(c.title).toBe(dept.title);
      expect(c.summary).toBe(dept.agent.intro);
    }
  });

  it("never grants a send/spend tool — every agent carries only draft tools (ADR-0013/#243)", () => {
    const forbidden = ["send", "post", "email", "spend", "publish", "deploy"];
    for (const c of agentContracts()) {
      for (const tool of c.tools) {
        expect(forbidden).not.toContain(tool.toLowerCase());
      }
    }
  });
});

describe("agent-registry/contract — the anti-drift latch (every department has metadata)", () => {
  it("buildAgentContract succeeds for every blueprint department (no missing metadata row)", () => {
    for (const dept of MARKETING_DEPARTMENTS) {
      expect(() => buildAgentContract(dept)).not.toThrow();
    }
  });

  it("every contract declares at least one capability, input and output", () => {
    for (const c of agentContracts()) {
      expect(c.capabilities.length).toBeGreaterThan(0);
      expect(c.inputs.length).toBeGreaterThan(0);
      expect(c.outputs.length).toBeGreaterThan(0);
    }
  });

  it("cost and risk tiers are always from the canonical sets", () => {
    for (const c of agentContracts()) {
      expect(COST_TIERS).toContain(c.costTier);
      expect(RISK_TIERS).toContain(c.riskTier);
    }
  });
});

describe("agent-registry/contract — risk tier consistency with the blueprint", () => {
  it("every #123 external-send department (social/email/ads) is external_send risk and surfaces external.send", () => {
    // One-way implication: a department whose drafts leave the building via the #13 external.send gate
    // MUST be external_send risk. (A department can also be external_send risk via its own send model —
    // e.g. reach/Comet, which is not in EXTERNAL_SEND_DEPARTMENTS — so this is deliberately not a biconditional.)
    for (const dept of MARKETING_DEPARTMENTS) {
      if (!isExternalSendRisk(dept.key)) continue;
      const c = buildAgentContract(dept);
      expect(c.riskTier).toBe("external_send");
      expect(c.gatedActions).toContain("external.send");
    }
  });

  it("matches the expected risk tier for every fleet handle (anti-drift map)", () => {
    const expected: Record<string, string> = {
      scout: "read_only",
      lens: "read_only",
      quill: "internal_draft",
      mark: "internal_draft",
      echo: "external_send",
      postmark: "external_send",
      bid: "external_send",
      comet: "external_send",
    };
    for (const c of agentContracts()) {
      expect(c.riskTier).toBe(expected[c.handle]);
    }
  });

  it("a read_only / internal_draft agent surfaces no downstream gated actions", () => {
    for (const c of agentContracts()) {
      if (c.riskTier !== "external_send") {
        expect(c.gatedActions).toEqual([]);
      }
    }
  });

  it("ads (Bid) surfaces the money action venture.ad_spend (paid acquisition is money, #243)", () => {
    expect(contractForHandle("bid")?.gatedActions).toContain("venture.ad_spend");
  });

  it("reach (Comet) sends autonomously but gates paid data credits (#280 money-only governance)", () => {
    const comet = contractForHandle("comet");
    expect(comet?.riskTier).toBe("external_send");
    expect(comet?.gatedActions).toEqual(["reach.data_credit_spend"]);
  });
});

describe("agent-registry/contract — handle helpers", () => {
  it("isFleetHandle is true only for fleet handles", () => {
    for (const h of FLEET_HANDLES) expect(isFleetHandle(h)).toBe(true);
    expect(isFleetHandle("owner")).toBe(false);
    expect(isFleetHandle("not-an-agent")).toBe(false);
  });

  it("contractForHandle returns undefined for a non-fleet handle", () => {
    expect(contractForHandle("scout")).toBeDefined();
    expect(contractForHandle("nope")).toBeUndefined();
  });

  it("handleHasCapability checks the declared capability set", () => {
    expect(handleHasCapability("scout", "seo.audit")).toBe(true);
    expect(handleHasCapability("scout", "email.draft_sequence")).toBe(false);
    expect(handleHasCapability("nope", "seo.audit")).toBe(false);
  });

  it("returns fresh arrays per build (no shared mutable state)", () => {
    const a = contractForHandle("quill")!;
    a.capabilities.push("injected");
    expect(contractForHandle("quill")!.capabilities).not.toContain("injected");
  });
});
