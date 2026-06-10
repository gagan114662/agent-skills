import { departmentForHandle } from "./blueprint.js";

/**
 * The marketing team panel (#123) — a **pure** projection of humans + department agents with their
 * roles and live presence (#105). The route gathers the workspace members, the personas, and the live
 * session member-ids (from `listLiveSessions`) and hands them here. An agent is `present` iff it has a
 * non-terminal session right now. Only blueprint agents appear (the panel is the department roster, not
 * every persona).
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
}): MarketingRoster {
  const live = new Set(input.liveSessionMemberIds);

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
        present: live.has(p.agentMemberId),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  return { humans, agents };
}
