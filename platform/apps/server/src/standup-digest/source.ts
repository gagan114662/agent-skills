/**
 * Daily agent standup digest — the **data-source seam** (issue #589).
 *
 * {@link DailyActivitySource} is the narrow interface the service consumes: given a workspace and a day,
 * return that day's raw {@link DailyActivityData} (per-agent artifacts, decisions, blockers, plans). The
 * production binding (wiring this to the real trace/run/deliverable/decision repositories) would touch shared
 * files, so it is a deliberate follow-up; see `standup-digest/default.ts`.
 *
 * The default binding is {@link FakeDailyActivitySource} — a **deterministic** generator seeded from the
 * workspace id + day, so the module produces a coherent, link-carrying digest with **zero external calls**
 * until a real source is wired in and the feature is enabled. Determinism (no clock, no `Math.random`) is
 * what lets the acceptance test assert on an exact digest.
 */

import type {
  AgentActivityInput,
  DailyActivityData,
  DigestPeriod,
} from "./types.js";

/** Supplies one workspace-day of raw per-agent activity to the digest service. */
export interface DailyActivitySource {
  /** Fetch every agent's activity for `workspaceId` over `period`. */
  fetch(workspaceId: string, period: DigestPeriod): Promise<DailyActivityData>;
}

/** FNV-1a 32-bit hash — a stable, dependency-free seed from a string. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG — deterministic uniform [0, 1) from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fleet's standing roles (#586), each with a couple of plausible artifact/decision/blocker/plan lines. */
const ROSTER: ReadonlyArray<{
  agentId: string;
  agentName: string;
  role: string;
  artifacts: string[];
  decisions: string[];
  blockers: string[];
  planned: string[];
}> = [
  {
    agentId: "scout",
    agentName: "Scout",
    role: "scout",
    artifacts: ["Surfaced 8 new high-intent prospects", "Refreshed the competitor pricing snapshot"],
    decisions: ["Prioritized the fintech segment for this week"],
    blockers: ["Awaiting access to the enrichment API"],
    planned: ["Score the new prospect batch", "Hand off the top 3 to the strategist"],
  },
  {
    agentId: "strategist",
    agentName: "Strategist",
    role: "strategist",
    artifacts: ["Updated the campaign brief positioning"],
    decisions: ["Chose value-first messaging over discount-led", "Set the weekly signup target to 140"],
    blockers: [],
    planned: ["Brief the writer on the new angle"],
  },
  {
    agentId: "writer",
    agentName: "Writer",
    role: "writer",
    artifacts: ["Drafted 3 LinkedIn posts", "Wrote the launch announcement"],
    decisions: [],
    blockers: ["Blocked on brand-fact-gate review of one claim"],
    planned: ["Revise the flagged claim", "Queue the posts for approval"],
  },
  {
    agentId: "distributor",
    agentName: "Distributor",
    role: "distributor",
    artifacts: ["Published 2 approved posts", "Scheduled the Reels short"],
    decisions: ["Held one post pending the #13 approval queue"],
    blockers: [],
    planned: ["Monitor engagement and reply to comments"],
  },
  {
    agentId: "analyst",
    agentName: "Analyst",
    role: "analyst",
    artifacts: ["Generated the weekly attribution rollup"],
    decisions: ["Flagged the activation dip for investigation"],
    blockers: [],
    planned: ["Trace the activation regression to its source"],
  },
];

/**
 * A deterministic, offline {@link DailyActivitySource}. Seeded from `workspaceId` + `day`, so the same
 * workspace-day always yields the same digest. Each roster agent contributes a seed-determined subset of its
 * candidate lines, and every entry carries a site-relative receipt link so the "working links" criterion is
 * exercised end to end. Used as the safe default binding (no network, no DB) and by unit tests.
 */
export class FakeDailyActivitySource implements DailyActivitySource {
  async fetch(workspaceId: string, period: DigestPeriod): Promise<DailyActivityData> {
    const rand = mulberry32(fnv1a(`${workspaceId}:${period.day}`));

    /** Take a seed-determined slice of `lines` (at least `min`), turning each into an entry with a receipt. */
    const take = <T>(lines: readonly string[], min: number, make: (line: string, n: number) => T): T[] => {
      if (lines.length === 0) return [];
      const count = Math.max(min, Math.min(lines.length, 1 + Math.floor(rand() * lines.length)));
      return lines.slice(0, count).map((line, n) => make(line, n));
    };

    const agents: AgentActivityInput[] = ROSTER.map((r) => {
      const ref = `${period.day}/${r.agentId}`;
      return {
        agentId: r.agentId,
        agentName: r.agentName,
        role: r.role,
        artifacts: take(r.artifacts, 0, (title, n) => ({
          id: `${r.agentId}-art-${n}`,
          title,
          kind: "deliverable",
          receipt: { label: "Receipt", url: `/workspaces/${workspaceId}/receipts/${ref}-art-${n}` },
        })),
        decisions: take(r.decisions, 0, (summary, n) => ({
          id: `${r.agentId}-dec-${n}`,
          summary,
          receipt: { label: "Decision", url: `/workspaces/${workspaceId}/decisions/${ref}-dec-${n}` },
        })),
        blockers: r.blockers.map((summary, n) => ({
          id: `${r.agentId}-blk-${n}`,
          summary,
          severity: n === 0 ? ("high" as const) : ("medium" as const),
          receipt: { label: "Trace", url: `/workspaces/${workspaceId}/traces/${ref}-blk-${n}` },
        })),
        planned: take(r.planned, 1, (summary, n) => ({
          id: `${r.agentId}-plan-${n}`,
          summary,
          receipt: { label: "Task", url: `/workspaces/${workspaceId}/tasks/${ref}-plan-${n}` },
        })),
      };
    });

    return { workspaceId, period, agents };
  }
}

/**
 * A {@link DailyActivitySource} that returns pre-canned data — for tests that want to assert on an exact
 * digest shape rather than the seeded fake. Throws if asked for a workspace it has no data for.
 */
export class StaticDailyActivitySource implements DailyActivitySource {
  constructor(private readonly byWorkspace: Map<string, DailyActivityData>) {}

  async fetch(workspaceId: string, period: DigestPeriod): Promise<DailyActivityData> {
    const data = this.byWorkspace.get(workspaceId);
    if (!data) throw new Error(`StaticDailyActivitySource: no data for workspace ${workspaceId}`);
    return { ...data, workspaceId, period };
  }
}
