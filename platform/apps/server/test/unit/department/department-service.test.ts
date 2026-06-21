import { describe, it, expect, vi } from "vitest";
import { seedDepartment, type DepartmentSeedDeps } from "../../../src/department/seed.js";
import { DepartmentService, type DepartmentDeps } from "../../../src/department/service.js";
import { resolveDepartmentCaps, type DepartmentCaps } from "../../../src/department/caps.js";
import { DEFAULT_DEPARTMENT_ROSTER } from "../../../src/department/blueprint.js";

const OWNER = { workspaceId: "ws-owner", memberId: "m-owner" };

/** An in-memory persona store keyed by handle — exercises the idempotency contract. */
function fakePersonaStore(prefill: string[] = []) {
  const byHandle = new Map<string, { id: string; agentMemberId: string }>();
  let n = 0;
  for (const h of prefill) byHandle.set(h, { id: `p-${h}`, agentMemberId: `am-${h}` });
  const createPersona = vi.fn(async (spec: { name: string }) => {
    const rec = { id: `p-${spec.name}`, agentMemberId: `am-${spec.name}` };
    byHandle.set(spec.name, rec);
    n += 1;
    return rec;
  });
  const seedDeps: DepartmentSeedDeps = {
    getPersonaByHandle: async (_ws, handle) => byHandle.get(handle.toLowerCase()),
    createPersona,
  };
  return { byHandle, createPersona, seedDeps, created: () => n };
}

describe("department/seed — idempotent identity seeding", () => {
  it("creates one persona per teammate on a fresh workspace (no send tool)", async () => {
    const store = fakePersonaStore();
    const result = await seedDepartment(
      { workspaceId: "ws", createdByMemberId: "m", roster: DEFAULT_DEPARTMENT_ROSTER },
      store.seedDeps,
    );
    expect(result.agents).toHaveLength(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(result.createdCount).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(result.agents.every((a) => a.created)).toBe(true);
    // Each create used the draft-only ceiling (no send/spend) and the handle as the member name.
    for (const call of store.createPersona.mock.calls) {
      const spec = call[0] as { name: string; allowedTools: string[]; model: string | null };
      expect(spec.allowedTools).toEqual(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);
      expect(spec.model).toBeNull();
    }
    // The result carries role + color for the rail / registry.
    const hermes = result.agents.find((a) => a.handle === "hermes")!;
    expect(hermes.role).toBe("Product owner");
    expect(hermes.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(hermes.lead).toBe(true);
  });

  it("re-running creates nothing new — matched by handle (idempotent)", async () => {
    const store = fakePersonaStore();
    await seedDepartment({ workspaceId: "ws", createdByMemberId: "m", roster: DEFAULT_DEPARTMENT_ROSTER }, store.seedDeps);
    expect(store.created()).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    const second = await seedDepartment(
      { workspaceId: "ws", createdByMemberId: "m", roster: DEFAULT_DEPARTMENT_ROSTER },
      store.seedDeps,
    );
    expect(store.created()).toBe(DEFAULT_DEPARTMENT_ROSTER.length); // no new creates
    expect(second.createdCount).toBe(0);
    expect(second.agents.every((a) => !a.created)).toBe(true);
  });

  it("reuses a persona whose handle coincides with an already-seeded fleet agent (never duplicates)", async () => {
    // `scout` already exists (e.g. seeded by the #123 marketing fleet) — the team reuses it.
    const store = fakePersonaStore(["scout"]);
    const result = await seedDepartment(
      { workspaceId: "ws", createdByMemberId: "m", roster: DEFAULT_DEPARTMENT_ROSTER },
      store.seedDeps,
    );
    expect(result.agents.find((a) => a.handle === "scout")!.created).toBe(false);
    expect(result.createdCount).toBe(DEFAULT_DEPARTMENT_ROSTER.length - 1);
  });
});

function makeService(over: Partial<DepartmentDeps> = {}, capsOver: Partial<DepartmentCaps> = {}) {
  const store = fakePersonaStore();
  const caps = (): DepartmentCaps => ({
    ...resolveDepartmentCaps({ enabled: true, ownerWorkspaceId: OWNER.workspaceId }),
    ...capsOver,
  });
  const deps: DepartmentDeps = {
    ...store.seedDeps,
    caps,
    listPresentHandles: async () => [...store.byHandle.keys()],
    countMembers: async () => ({ humans: 3, agents: store.byHandle.size }),
    countDecisionsCaptured: async () => 12,
    ...over,
  };
  return { service: new DepartmentService(deps), store };
}

describe("department/service — view (read-only roster + rail)", () => {
  it("returns the roster + the rail footer; enabled for the owner workspace", async () => {
    const { service } = makeService();
    const view = await service.view(OWNER);
    expect(view.enabled).toBe(true);
    expect(view.canManage).toBe(true);
    expect(view.roster).toHaveLength(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(view.rail.summary).toBe("3 humans · 0 agents · 12 decisions captured");
    // Every teammate carries its role + color identity for the rail / authored-message chips (#371/#370).
    const hermes = view.roster.find((t) => t.handle === "hermes")!;
    expect(hermes.role).toBe("Product owner");
    expect(hermes.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(hermes.lead).toBe(true);
  });

  it("reflects flag-off as not-enabled but still lists the roster (catalog read-only)", async () => {
    const { service } = makeService({}, { enabled: false });
    const view = await service.view(OWNER);
    expect(view.enabled).toBe(false);
    expect(view.roster).toHaveLength(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(view.roster.every((e) => !e.enabled)).toBe(true);
  });

  it("filters non-roster personas out of the present set", async () => {
    const { service } = makeService({
      listPresentHandles: async () => ["hermes", "owner-bot", "quill"],
    });
    const view = await service.view(OWNER);
    expect(view.roster.find((e) => e.handle === "hermes")!.present).toBe(true);
    expect(view.roster.find((e) => e.handle === "comet")!.present).toBe(false);
  });
});

describe("department/service — seed (owner-gated, idempotent)", () => {
  it("seeds the team for the owner workspace and returns the fresh view", async () => {
    const { service, store } = makeService();
    const result = await service.seed(OWNER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdCount).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    expect(store.byHandle.size).toBe(DEFAULT_DEPARTMENT_ROSTER.length);
    // Every seeded teammate is now present + enabled in the returned registry view.
    expect(result.view.roster.every((e) => e.present && e.enabled)).toBe(true);
  });

  it("409s and creates nothing for a workspace out of owner-first scope (fail-closed)", async () => {
    const { service, store } = makeService();
    const result = await service.seed({ workspaceId: "ws-other", memberId: "m" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(409);
    expect(store.byHandle.size).toBe(0);
  });

  it("409s and creates nothing when the flag is off", async () => {
    const { service, store } = makeService({}, { enabled: false });
    const result = await service.seed(OWNER);
    expect(result.ok).toBe(false);
    expect(store.byHandle.size).toBe(0);
  });

  it("is idempotent: a second seed creates nothing new", async () => {
    const { service } = makeService();
    await service.seed(OWNER);
    const again = await service.seed(OWNER);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.createdCount).toBe(0);
  });
});
