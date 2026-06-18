import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEPARTMENT_ROSTER,
  DEPARTMENT_DRAFT_TOOLS,
  departmentHandles,
  departmentPersonaForHandle,
  isDepartmentHandle,
  resolveDepartmentRoster,
} from "../../../src/department/blueprint.js";
import {
  DEPARTMENT_DEFAULTS,
  isDepartmentSeedEnabledForWorkspace,
  isOwnerWorkspace,
  resolveDepartmentCaps,
} from "../../../src/department/caps.js";
import { buildMembersRail, DECISION_STATUSES, isCapturedDecision } from "../../../src/department/rail.js";
import { buildDepartmentRegistry, departmentContracts } from "../../../src/department/registry.js";
import { APPROVAL_STATUSES } from "../../../src/approvals/policy.js";

const OWNER = "ws-owner";

describe("department/blueprint — the named team", () => {
  it("seeds the reload.chat roster: a lead + SEO/Design/Developer/QA/DevOps, all with role + color", () => {
    expect(departmentHandles()).toEqual(["hermes", "scout", "lens", "atlas", "sentinel", "echo"]);
    // Exactly one lead (the Product owner).
    const leads = DEFAULT_DEPARTMENT_ROSTER.filter((p) => p.lead);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.handle).toBe("hermes");
    expect(leads[0]!.role).toBe("Product owner");
    // Every teammate carries a role label and a valid hex accent color.
    for (const p of DEFAULT_DEPARTMENT_ROSTER) {
      expect(p.role.length).toBeGreaterThan(0);
      expect(p.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.handle).toBe(p.handle.toLowerCase());
    }
  });

  it("carries draft-only tools and no send/spend tool (identity/display only — #200)", () => {
    expect([...DEPARTMENT_DRAFT_TOOLS]).toEqual(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
    const banned = ["send", "post", "email", "spend", "deploy", "publish"];
    for (const p of DEFAULT_DEPARTMENT_ROSTER) {
      const prompt = p.systemPrompt.toLowerCase();
      expect(prompt).toContain("approval queue");
      // No tool name in the ceiling implies a send/spend capability.
      for (const tool of DEPARTMENT_DRAFT_TOOLS) {
        expect(banned).not.toContain(tool.toLowerCase());
      }
    }
  });

  it("has unique handles, display names, departments and colors (no collision in the roster)", () => {
    const handles = new Set(DEFAULT_DEPARTMENT_ROSTER.map((p) => p.handle));
    const departments = new Set(DEFAULT_DEPARTMENT_ROSTER.map((p) => p.department));
    const colors = new Set(DEFAULT_DEPARTMENT_ROSTER.map((p) => p.color));
    expect(handles.size).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(departments.size).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(colors.size).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
  });

  it("looks up a teammate by handle (case-insensitive, @-tolerant)", () => {
    expect(departmentPersonaForHandle("HERMES")!.role).toBe("Product owner");
    expect(departmentPersonaForHandle("@atlas")!.displayName).toBe("Atlas");
    expect(departmentPersonaForHandle("nobody")).toBeUndefined();
    expect(isDepartmentHandle("sentinel")).toBe(true);
    expect(isDepartmentHandle("quill")).toBe(false);
  });
});

describe("department/blueprint — configurable roster overrides", () => {
  it("returns the defaults unchanged when no overrides are given", () => {
    expect(resolveDepartmentRoster()).toBe(DEFAULT_DEPARTMENT_ROSTER);
    expect(resolveDepartmentRoster([])).toBe(DEFAULT_DEPARTMENT_ROSTER);
  });

  it("renames / relabels / recolors a teammate by handle and keeps the prompt in sync", () => {
    const roster = resolveDepartmentRoster([
      { handle: "lens", displayName: "Iris", role: "Brand & Design", color: "#123456" },
    ]);
    const lens = roster.find((p) => p.handle === "lens")!;
    expect(lens.displayName).toBe("Iris");
    expect(lens.role).toBe("Brand & Design");
    expect(lens.color).toBe("#123456");
    expect(lens.systemPrompt).toContain("Iris");
    expect(lens.systemPrompt).toContain("Brand & Design");
    // The handle and lead structure are fixed (only labels/colors are tunable).
    expect(lens.handle).toBe("lens");
    expect(departmentHandles(roster)).toEqual(departmentHandles());
  });

  it("ignores an override for an unknown handle and a malformed color (fail-safe)", () => {
    const roster = resolveDepartmentRoster([
      { handle: "ghost", role: "Nope" },
      { handle: "scout", color: "not-a-color" },
    ]);
    expect(roster.find((p) => p.handle === "ghost")).toBeUndefined();
    // Bad color → the default green is kept, not a broken value.
    expect(roster.find((p) => p.handle === "scout")!.color).toBe(
      DEFAULT_DEPARTMENT_ROSTER.find((p) => p.handle === "scout")!.color,
    );
  });
});

describe("department/caps — default-OFF, owner-workspace-first", () => {
  it("defaults to OFF + owner-first + the default roster when no config is set", () => {
    const caps = resolveDepartmentCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.ownerWorkspaceOnly).toBe(true);
    expect(caps.ownerWorkspaceId).toBeNull();
    expect(caps.roster).toBe(DEFAULT_DEPARTMENT_ROSTER);
    expect(DEPARTMENT_DEFAULTS.enabled).toBe(false);
  });

  it("enables seeding ONLY for the named owner workspace when owner-first (fail-closed)", () => {
    const caps = resolveDepartmentCaps({ enabled: true, ownerWorkspaceId: OWNER });
    expect(isOwnerWorkspace(caps, OWNER)).toBe(true);
    expect(isDepartmentSeedEnabledForWorkspace(caps, OWNER)).toBe(true);
    expect(isDepartmentSeedEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("enabling WITHOUT naming the owner seeds NOBODY (the safest default)", () => {
    const caps = resolveDepartmentCaps({ enabled: true });
    expect(isDepartmentSeedEnabledForWorkspace(caps, OWNER)).toBe(false);
    expect(isDepartmentSeedEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("can roll out to every tenant when owner-first is explicitly turned off", () => {
    const caps = resolveDepartmentCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isDepartmentSeedEnabledForWorkspace(caps, "any-ws")).toBe(true);
  });

  it("a disabled flag never seeds, even with an owner named", () => {
    const caps = resolveDepartmentCaps({ enabled: false, ownerWorkspaceId: OWNER });
    expect(isDepartmentSeedEnabledForWorkspace(caps, OWNER)).toBe(false);
  });

  it("threads roster overrides through into the resolved caps", () => {
    const caps = resolveDepartmentCaps({ roster: [{ handle: "hermes", role: "Chief of Staff" }] });
    expect(caps.roster.find((p) => p.handle === "hermes")!.role).toBe("Chief of Staff");
  });
});

describe("department/rail — '{n} humans · {n} agents · {n} decisions captured'", () => {
  it("renders the reload.chat footer with correct pluralization", () => {
    expect(buildMembersRail({ humanCount: 6, agentCount: 7, decisionsCaptured: 247 }).summary).toBe(
      "6 humans · 7 agents · 247 decisions captured",
    );
    expect(buildMembersRail({ humanCount: 1, agentCount: 1, decisionsCaptured: 0 }).summary).toBe(
      "1 human · 1 agent · 0 decisions captured",
    );
  });

  it("clamps negative / fractional counts to non-negative integers", () => {
    const rail = buildMembersRail({ humanCount: -3, agentCount: 2.9, decisionsCaptured: Number.NaN });
    expect(rail.humanCount).toBe(0);
    expect(rail.agentCount).toBe(2);
    expect(rail.decisionsCaptured).toBe(0);
  });

  it("counts a decision only once a human has approved/executed/failed/rejected — not pending/expired", () => {
    expect(isCapturedDecision("approved")).toBe(true);
    expect(isCapturedDecision("executed")).toBe(true);
    expect(isCapturedDecision("failed")).toBe(true);
    expect(isCapturedDecision("rejected")).toBe(true);
    expect(isCapturedDecision("pending")).toBe(false);
    expect(isCapturedDecision("expired")).toBe(false);
    // Every decision status is a real approval status (no drift).
    for (const s of DECISION_STATUSES) expect(APPROVAL_STATUSES).toContain(s);
  });
});

describe("department/registry — present in the #282 registry surface", () => {
  it("builds a #282-shaped contract per teammate: identity/display only (read-only, no gated actions)", () => {
    const contracts = departmentContracts(DEFAULT_DEPARTMENT_ROSTER);
    expect(contracts).toHaveLength(DEFAULT_DEPARTMENT_ROSTER.length);
    for (const c of contracts) {
      expect(c.riskTier).toBe("read_only");
      expect(c.gatedActions).toEqual([]);
      expect(c.tools).toEqual([...DEPARTMENT_DRAFT_TOOLS]);
      expect(c.title.length).toBeGreaterThan(0);
    }
  });

  it("marks present iff seeded and enabled iff (flag on AND present AND owner-first scope)", () => {
    const entries = buildDepartmentRegistry({
      roster: DEFAULT_DEPARTMENT_ROSTER,
      presentHandles: ["hermes", "scout"],
      enabled: true,
      isOwnerWorkspace: true,
      ownerWorkspaceOnly: true,
    });
    const hermes = entries.find((e) => e.contract.handle === "hermes")!;
    const atlas = entries.find((e) => e.contract.handle === "atlas")!;
    expect(hermes.present).toBe(true);
    expect(hermes.enabled).toBe(true);
    expect(atlas.present).toBe(false);
    expect(atlas.enabled).toBe(false);
  });

  it("lists the catalog but enables NOBODY when the flag is off (byte-for-byte today)", () => {
    const entries = buildDepartmentRegistry({
      roster: DEFAULT_DEPARTMENT_ROSTER,
      presentHandles: ["hermes", "scout"],
      enabled: false,
      isOwnerWorkspace: true,
      ownerWorkspaceOnly: true,
    });
    expect(entries).toHaveLength(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(entries.every((e) => !e.enabled)).toBe(true);
  });

  it("does not enable a non-owner workspace under owner-first even when present + flag on", () => {
    const entries = buildDepartmentRegistry({
      roster: DEFAULT_DEPARTMENT_ROSTER,
      presentHandles: ["hermes"],
      enabled: true,
      isOwnerWorkspace: false,
      ownerWorkspaceOnly: true,
    });
    expect(entries.find((e) => e.contract.handle === "hermes")!.enabled).toBe(false);
  });
});
