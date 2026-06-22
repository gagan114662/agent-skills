import { describe, it, expect } from "vitest";
import { gateAction, DEFAULT_GATE_POLICY, type GatePolicy } from "../../src/content-guard/gate.js";
import { resolveGatePolicy } from "../../src/content-guard/caps.js";

describe("content-guard gate — non-external actions", () => {
  it("auto-allows an action provably from trusted content", () => {
    const d = gateAction({ type: "email.send", derivedFromExternal: false, provenance: "trusted" });
    expect(d.outcome).toBe("auto");
    expect(d.requiresApproval).toBe(false);
    expect(d.external).toBe(false);
  });
});

describe("content-guard gate — external actions always need approval", () => {
  it("requires approval for an external-derived action with no injection", () => {
    const d = gateAction({ type: "email.send", derivedFromExternal: true, injectionSeverity: "none" });
    expect(d.outcome).toBe("needs-approval");
    expect(d.requiresApproval).toBe(true);
    expect(d.blocked).toBe(false);
  });

  it("hard-blocks an external-derived action carrying a high-severity injection", () => {
    const d = gateAction({ type: "payment.charge", derivedFromExternal: true, injectionSeverity: "high" });
    expect(d.outcome).toBe("blocked");
    expect(d.blocked).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it("gates (not blocks) a low/medium injection under the default high threshold", () => {
    expect(gateAction({ type: "x", derivedFromExternal: true, injectionSeverity: "medium" }).outcome).toBe(
      "needs-approval",
    );
  });
});

describe("content-guard gate — fail-closed", () => {
  it("treats a missing derivedFromExternal flag with non-trusted provenance as external", () => {
    const d = gateAction({ type: "x" });
    expect(d.external).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it("treats unknown provenance as external even when the flag claims false", () => {
    // The flag says not-external, but provenance is not provably trusted ⇒ fail closed to external.
    const d = gateAction({ type: "x", derivedFromExternal: false, provenance: "web" });
    expect(d.external).toBe(true);
    expect(d.requiresApproval).toBe(true);
  });

  it("treats a malformed action as the dangerous case", () => {
    // @ts-expect-error — exercising the defensive non-object path
    const d = gateAction(null);
    expect(d.requiresApproval).toBe(true);
  });

  it("never returns auto for external content under ANY severity", () => {
    for (const sev of ["none", "low", "medium", "high"] as const) {
      const d = gateAction({ type: "x", derivedFromExternal: true, injectionSeverity: sev });
      expect(d.outcome).not.toBe("auto");
      expect(d.requiresApproval).toBe(true);
    }
  });
});

describe("content-guard gate — policy / caps", () => {
  it("hardBlockAtSeverity 'off' downgrades blocks to approval but keeps the gate", () => {
    const policy: GatePolicy = { hardBlockAtSeverity: "off" };
    const d = gateAction({ type: "x", derivedFromExternal: true, injectionSeverity: "high" }, policy);
    expect(d.blocked).toBe(false);
    expect(d.requiresApproval).toBe(true);
  });

  it("a lower threshold blocks medium injections", () => {
    const policy: GatePolicy = { hardBlockAtSeverity: "medium" };
    expect(gateAction({ type: "x", derivedFromExternal: true, injectionSeverity: "medium" }, policy).blocked).toBe(
      true,
    );
  });

  it("resolveGatePolicy defaults to high, parses overrides, and clamps junk", () => {
    expect(resolveGatePolicy({}).hardBlockAtSeverity).toBe("high");
    expect(resolveGatePolicy({ CONTENT_GUARD_HARD_BLOCK: "medium" }).hardBlockAtSeverity).toBe("medium");
    expect(resolveGatePolicy({ CONTENT_GUARD_HARD_BLOCK: "off" }).hardBlockAtSeverity).toBe("off");
    expect(resolveGatePolicy({ CONTENT_GUARD_HARD_BLOCK: "garbage" }).hardBlockAtSeverity).toBe("high");
  });

  it("default policy blocks at high", () => {
    expect(DEFAULT_GATE_POLICY.hardBlockAtSeverity).toBe("high");
  });
});
