import { departmentForHandle } from "./blueprint.js";

/**
 * The marketing team panel (#123) — a **pure** projection of humans + department agents with their
 * roles and presence (#105). The route gathers the workspace members, the personas, the live session
 * member-ids (from `listLiveSessions`), and whether the fleet is enabled, and hands them here.
 *
 * Presence (#166, QA bug 13): an agent is `present` when the fleet is enabled (it's a standing
 * department persona, available to be @mentioned) OR it has a non-terminal session right now. Before
 * this, presence was live-session-only, so agents always rendered grey/offline — doubly so once every
 * session was failing to spawn. `fleetEnabled` defaults to false, so callers that don't pass it keep
 * the prior live-only behavior. Only blueprint agents appear (the department roster, not every persona).
 */
export interface RosterMember {
  id: string;
  kind: "human" | "agent";
  displayName: string;
}

export interface RosterPersona {
  agentMemberId: string;
  name: string;
}

export interface MarketingRoster {
  humans: Array<{ memberId: string; displayName: string }>;
  agents: Array<{
    memberId: string;
    handle: string;
    department: string;
    title: string;
    present: boolean;
  }>;
}

export function buildMarketingRoster(input: {
  members: RosterMember[];
  personas: RosterPersona[];
  liveSessionMemberIds: string[];
  /** Whether the marketing fleet is enabled for this workspace. Default false (live-only presence). */
  fleetEnabled?: boolean;
}): MarketingRoster {
  const live = new Set(input.liveSessionMemberIds);
  const fleetEnabled = input.fleetEnabled ?? false;

  const humans = input.members
    .filter((m) => m.kind === "human")
    .map((m) => ({ memberId: m.id, displayName: m.displayName }));

  const agents = input.personas
    .map((p) => {
      const dept = departmentForHandle(p.name);
      if (!dept) return undefined; // not a marketing agent — not part of the department panel
      return {
        memberId: p.agentMemberId,
        handle: dept.agent.handle,
        department: dept.key,
        title: dept.title,
        present: fleetEnabled || live.has(p.agentMemberId),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  return { humans, agents };
}
