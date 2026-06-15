import { describe, it, expect } from "vitest";
import type { ServiceKind } from "../../src/onboarding/types.js";
import { REAL_WORLD_TOOL_NAMES } from "../../src/realworld/types.js";
import {
  REAL_WORLD_TOOLS,
  realWorldToolSpec,
  isActuator,
  isReadOnly,
  isRealWorldToolName,
  realWorldRequiredAccountKinds,
} from "../../src/realworld/tools.js";
import {
  decideToolGate,
  missingAccountsFor,
  realWorldReadinessNeeded,
} from "../../src/realworld/decide.js";

const NONE = new Set<ServiceKind>();
const ALL = new Set<ServiceKind>(["hosting", "esp", "registrar", "ad_account"]);

describe("real-world tool surface (#231) — safety invariants", () => {
  it("enumerates exactly the issue capabilities (incl. #250 publish_site) and is a closed surface", () => {
    expect([...REAL_WORLD_TOOL_NAMES].sort()).toEqual(
      ["browse", "call_api", "post_social", "publish", "publish_site", "research", "send_email", "store_asset"].sort(),
    );
    // unknown names throw — a new tool can never bypass the gate by being unclassified.
    expect(() => realWorldToolSpec("fly_a_drone" as never)).toThrow(/unknown real-world tool/);
    expect(isRealWorldToolName("publish")).toBe(true);
    expect(isRealWorldToolName("nope")).toBe(false);
  });

  it("publish_site (#250) is an autonomous actuator — money-free + reversible, no #13 gate", () => {
    const spec = realWorldToolSpec("publish_site");
    expect(spec.dataFlow).toBe("actuate");
    expect(spec.reversibility).toBe("reversible");
    expect(spec.requiresApproval).toBe(false); // opening a PR is autonomous (#243 money-only)
    expect(spec.requiredAccounts).toEqual([]); // ipop owns the repo — server token, no connected account
    const gate = decideToolGate("publish_site", { connectedAccounts: NONE });
    expect(gate.allowed).toBe(true);
    expect(gate.requiresApproval).toBe(false);
  });

  it("every IRREVERSIBLE tool requires a #13 approval (#200)", () => {
    for (const t of REAL_WORLD_TOOLS) {
      if (t.reversibility === "irreversible") expect(t.requiresApproval).toBe(true);
    }
  });

  it("read-only tools are never gated and never act through an account (#223)", () => {
    for (const t of REAL_WORLD_TOOLS) {
      if (t.dataFlow === "read") {
        expect(t.requiresApproval).toBe(false);
        expect(t.requiredAccounts).toEqual([]);
        expect(isReadOnly(t.name)).toBe(true);
        expect(isActuator(t.name)).toBe(false);
      }
    }
  });

  it("classifies browse/research as read and the outward capabilities as gated actuators", () => {
    expect(decideToolGate("browse", { connectedAccounts: NONE }).requiresApproval).toBe(false);
    expect(decideToolGate("research", { connectedAccounts: NONE }).dataFlow).toBe("read");
    for (const name of ["publish", "send_email", "post_social", "call_api"] as const) {
      expect(isActuator(name)).toBe(true);
      expect(realWorldToolSpec(name).requiresApproval).toBe(true);
    }
  });
});

describe("decideToolGate (#231) — account-gated readiness", () => {
  it("blocks an actuator until its required account is connected, with the exact missing list", () => {
    const blocked = decideToolGate("publish", { connectedAccounts: NONE });
    expect(blocked.allowed).toBe(false);
    expect(blocked.missingAccounts).toEqual(["hosting"]);
    expect(blocked.reason).toMatch(/connect hosting/);

    const ready = decideToolGate("publish", { connectedAccounts: new Set<ServiceKind>(["hosting"]) });
    expect(ready.allowed).toBe(true);
    expect(ready.requiresApproval).toBe(true); // still gated — outward/brand
  });

  it("send_email needs both an ESP and a registrar (authenticated sending domain)", () => {
    expect(missingAccountsFor("send_email", new Set<ServiceKind>(["esp"]))).toEqual(["registrar"]);
    expect(decideToolGate("send_email", { connectedAccounts: ALL }).allowed).toBe(true);
  });

  it("read-only and internal tools are allowed with no accounts connected", () => {
    for (const name of ["browse", "research", "store_asset"] as const) {
      const d = decideToolGate(name, { connectedAccounts: NONE });
      expect(d.allowed).toBe(true);
      expect(d.missingAccounts).toEqual([]);
    }
  });
});

describe("realWorldReadiness (#231) — what the owner must connect for real work", () => {
  it("required kinds are the union across outward tools", () => {
    expect(realWorldRequiredAccountKinds().sort()).toEqual(
      ["ad_account", "esp", "hosting", "registrar"].sort(),
    );
  });

  it("with nothing connected, every real-work account is still needed", () => {
    expect(realWorldReadinessNeeded(NONE).sort()).toEqual(
      ["ad_account", "esp", "hosting", "registrar"].sort(),
    );
  });

  it("connecting hosting clears it from the needed set", () => {
    expect(realWorldReadinessNeeded(new Set<ServiceKind>(["hosting"]))).not.toContain("hosting");
  });
});
