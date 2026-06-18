/**
 * The Department service (#371, ADR-0371) — the IO orchestrator that (a) renders the named team for a
 * workspace (the registry projection + the members-rail footer) and (b) idempotently seeds the team, gated
 * owner-workspace-first + default-OFF. It owns **no new action path**: seeding only mints identity/display
 * personas through the existing #59 persona seam; every real action the team's drafts imply still flows
 * through the #13 gate (#200).
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos in
 * `default.ts` (mirrors `agent-registry/service.ts` / `garden/service.ts`).
 */
import type { DepartmentCaps } from "./caps.js";
import { isDepartmentSeedEnabledForWorkspace, isOwnerWorkspace } from "./caps.js";
import { departmentHandles } from "./blueprint.js";
import { buildDepartmentRegistry } from "./registry.js";
import { buildMembersRail, type MembersRail } from "./rail.js";
import { seedDepartment, type DepartmentSeedDeps, type SeededDepartmentAgent } from "./seed.js";

export interface DepartmentIdentity {
  workspaceId: string;
  memberId: string;
}

export interface DepartmentDeps extends DepartmentSeedDeps {
  /** Resolve the per-workspace caps (the seed flag + owner-first + the effective roster). */
  caps(workspaceId: string): DepartmentCaps;
  /** The @handles already seeded in the workspace (from `listPersonas`). */
  listPresentHandles(workspaceId: string): Promise<string[]>;
  /** Live member counts by kind (humans + agents) for the rail. */
  countMembers(workspaceId: string): Promise<{ humans: number; agents: number }>;
  /** How many #13 approval requests reached a human decision (the "decisions captured" count). */
  countDecisionsCaptured(workspaceId: string): Promise<number>;
}

/**
 * One teammate as the console renders it: the persona identity (handle, displayName, role, color, lead)
 * plus the #282 registry presence (present iff seeded; enabled iff flag-on + present + owner-first scope).
 * The role + color are what the members rail and authored-message chips render (#371 / #370 bridge).
 */
export interface DepartmentTeammate {
  handle: string;
  displayName: string;
  role: string;
  color: string;
  lead: boolean;
  summary: string;
  /** True when this persona has been seeded in the workspace (it can be @mentioned). */
  present: boolean;
  /** True when the team is enabled for this workspace AND the persona is present (owner-first). */
  enabled: boolean;
}

export interface DepartmentView {
  /** True when the team may be (re)seeded for this workspace (flag on + owner-first scope). */
  enabled: boolean;
  /** True when the caller may trigger a seed here — same as `enabled` (owner-first). */
  canManage: boolean;
  /** The named team — each teammate's identity (role + color) + its #282 registry presence flags. */
  roster: DepartmentTeammate[];
  /** The members-rail footer: humans · agents · decisions captured. */
  rail: MembersRail;
}

export type SeedResult =
  | { ok: true; seeded: SeededDepartmentAgent[]; createdCount: number; view: DepartmentView }
  | { ok: false; code: number; error: string };

export class DepartmentService {
  constructor(private readonly deps: DepartmentDeps) {}

  /** Build the read-only view (roster + rail). Always works — when the flag is off, no entry is enabled. */
  async view(identity: DepartmentIdentity): Promise<DepartmentView> {
    const { workspaceId } = identity;
    const caps = this.deps.caps(workspaceId);
    const rosterHandles = new Set(departmentHandles(caps.roster).map((h) => h.toLowerCase()));
    const presentHandles = (await this.deps.listPresentHandles(workspaceId)).filter((h) =>
      rosterHandles.has(h.toLowerCase()),
    );
    // Build the #282-shaped registry entries (proving the team's presence in the registry surface), then
    // zip each teammate's persona identity (role + color + lead) onto its present/enabled flags by handle.
    const entries = buildDepartmentRegistry({
      roster: caps.roster,
      presentHandles,
      enabled: caps.enabled,
      isOwnerWorkspace: isOwnerWorkspace(caps, workspaceId),
      ownerWorkspaceOnly: caps.ownerWorkspaceOnly,
    });
    const entryByHandle = new Map(entries.map((e) => [e.contract.handle, e] as const));
    const roster: DepartmentTeammate[] = caps.roster.map((p) => {
      const entry = entryByHandle.get(p.handle);
      return {
        handle: p.handle,
        displayName: p.displayName,
        role: p.role,
        color: p.color,
        lead: p.lead,
        summary: p.summary,
        present: entry?.present ?? false,
        enabled: entry?.enabled ?? false,
      };
    });
    const [members, decisionsCaptured] = await Promise.all([
      this.deps.countMembers(workspaceId),
      this.deps.countDecisionsCaptured(workspaceId),
    ]);
    const rail = buildMembersRail({
      humanCount: members.humans,
      agentCount: members.agents,
      decisionsCaptured,
    });
    const enabled = isDepartmentSeedEnabledForWorkspace(caps, workspaceId);
    return { enabled, canManage: enabled, roster, rail };
  }

  /**
   * Idempotently seed the team. Owner-gated: a workspace out of owner-first scope (or with the flag off)
   * gets a 409 and nothing is created — fail-closed (#200 §4). On success the team is ensured (re-running
   * creates nothing new) and the fresh view is returned.
   */
  async seed(identity: DepartmentIdentity): Promise<SeedResult> {
    const { workspaceId, memberId } = identity;
    const caps = this.deps.caps(workspaceId);
    if (!isDepartmentSeedEnabledForWorkspace(caps, workspaceId)) {
      return { ok: false, code: 409, error: "the department team is not enabled for this workspace" };
    }
    const result = await seedDepartment(
      { workspaceId, createdByMemberId: memberId, roster: caps.roster },
      this.deps,
    );
    const view = await this.view(identity);
    return { ok: true, seeded: result.agents, createdCount: result.createdCount, view };
  }
}
