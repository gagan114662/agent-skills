import { describe, it, expect } from "vitest";
import {
  RoleRegistry,
  RoleRegistryError,
  defaultRoleRegistry,
} from "../../src/agent-roles/registry.js";
import { ROLE_DEFINITIONS } from "../../src/agent-roles/roles.js";
import { ROLE_IDS, type RoleDefinition } from "../../src/agent-roles/types.js";

function def(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id: "scout",
    title: "Scout",
    mandate: "find things",
    allowedTools: ["web.search"],
    outputs: ["prospect-list"],
    handlesTaskKinds: ["research"],
    keywords: ["find"],
    ...overrides,
  };
}

describe("agent-roles/registry — canonical roster", () => {
  it("defaultRoleRegistry exposes exactly the five canonical roles in order", () => {
    const reg = defaultRoleRegistry();
    expect(reg.roleIds()).toEqual([...ROLE_IDS]);
  });

  it("every canonical role has a mandate, a non-empty scoped toolset, and outputs", () => {
    const reg = defaultRoleRegistry();
    for (const role of reg.list()) {
      expect(role.mandate.trim().length).toBeGreaterThan(0);
      expect(role.allowedTools.length).toBeGreaterThan(0);
      expect(role.outputs.length).toBeGreaterThan(0);
      expect(role.handlesTaskKinds.length).toBeGreaterThan(0);
    }
  });

  it("each task kind is owned by exactly one canonical role (no overlap, no gap)", () => {
    const reg = defaultRoleRegistry();
    for (const kind of ["research", "strategy", "drafting", "distribution", "analysis"] as const) {
      expect(reg.rolesForKind(kind)).toHaveLength(1);
    }
  });

  it("only the distributor may send/publish (dangerous edges are scoped tight)", () => {
    const reg = defaultRoleRegistry();
    for (const role of reg.roleIds()) {
      const canSend = reg.toolAllowed(role, "email.send") || reg.toolAllowed(role, "social.publish");
      expect(canSend).toBe(role === "distributor");
    }
  });
});

describe("agent-roles/registry — lookups", () => {
  const reg = defaultRoleRegistry();

  it("get / require return the definition for a known role", () => {
    expect(reg.get("writer")?.title).toBe("Writer");
    expect(reg.require("writer").id).toBe("writer");
  });

  it("get returns undefined and require throws for an unknown role", () => {
    expect(reg.get("nobody")).toBeUndefined();
    expect(() => reg.require("nobody")).toThrow(RoleRegistryError);
  });

  it("has narrows an arbitrary string to a known role", () => {
    expect(reg.has("analyst")).toBe(true);
    expect(reg.has("ghost")).toBe(false);
  });

  it("toolAllowed enforces the scoped toolset and fails closed for unknown roles", () => {
    expect(reg.toolAllowed("scout", "web.search")).toBe(true);
    expect(reg.toolAllowed("scout", "email.send")).toBe(false);
    expect(reg.toolAllowed("ghost", "web.search")).toBe(false);
  });

  it("allowedTools / outputsFor return fresh copies that cannot mutate the registry", () => {
    const tools = reg.allowedTools("scout");
    tools.push("email.send");
    expect(reg.toolAllowed("scout", "email.send")).toBe(false);

    const outputs = reg.outputsFor("analyst");
    outputs.push("hacked");
    expect(reg.outputsFor("analyst")).not.toContain("hacked");
  });
});

describe("agent-roles/registry — construction validation", () => {
  it("rejects an empty roster", () => {
    expect(() => new RoleRegistry([])).toThrow(RoleRegistryError);
  });

  it("rejects duplicate role ids", () => {
    expect(() => new RoleRegistry([def(), def()])).toThrow(/duplicate role id/);
  });

  it("rejects a role with an empty mandate", () => {
    expect(() => new RoleRegistry([def({ mandate: "   " })])).toThrow(/empty mandate/);
  });

  it("rejects a role with no allowed tools (could never act)", () => {
    expect(() => new RoleRegistry([def({ allowedTools: [] })])).toThrow(/empty allowedTools/);
  });

  it("accepts a well-formed custom roster", () => {
    const reg = new RoleRegistry([def({ id: "strategist", title: "Strategist" })]);
    expect(reg.roleIds()).toEqual(["strategist"]);
  });
});

describe("agent-roles/roles — frozen source of truth", () => {
  it("ROLE_DEFINITIONS is frozen", () => {
    expect(Object.isFrozen(ROLE_DEFINITIONS)).toBe(true);
  });
});
