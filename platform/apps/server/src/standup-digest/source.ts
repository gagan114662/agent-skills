/**
 * Daily agent standup digest — the **data-source seam** (issue #589).
 *
 * {@link DailyActivitySource} is the narrow interface the service consumes: given a workspace and a day,
 * return that day's raw {@link DailyActivityData} (per-agent artifacts, decisions, blockers, plans).
 *
 * The production binding adapts the repository-backed source in `db-source.ts`; the fake source below remains
 * a deterministic no-IO fixture for tests and demos. Determinism (no clock, no `Math.random`) is what lets
 * the acceptance test assert on an exact digest.
 */

import type {
  AgentActivityInput,
  BlockerSeverity,
  DailyActivityData,
  DigestPeriod,
} from "./types.js";

/** Supplies one workspace-day of raw per-agent activity to the digest service. */
export interface DailyActivitySource {
  /** Fetch every agent's activity for `workspaceId` over `period`. */
  fetch(workspaceId: string, period: DigestPeriod): Promise<DailyActivityData>;
}

export interface DigestAgentRef {
  id: string;
  name: string;
  role?: string | null;
}

export type DigestSessionStatus =
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "idle_reaped"
  | "canceled";

export interface DigestSessionRow {
  id: string;
  agentMemberId: string;
  agentName?: string | null;
  command: string;
  status: DigestSessionStatus;
  result?: string | null;
  branch?: string | null;
  headSha?: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface DigestDecisionRow {
  id: string;
  decidedByMemberId: string | null;
  title: string;
  rationale?: string | null;
  createdAt: Date;
}

export interface DigestArtifactRow {
  id: string;
  tool: string;
  provider: string;
  status: string;
  url: string | null;
  detail: string;
  createdAt: Date;
}

export interface DigestTaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assigneeMemberId: string | null;
  updatedAt: Date;
}

export interface RepositoryDailyActivitySourceDeps {
  listAgents(workspaceId: string): Promise<DigestAgentRef[]>;
  listSessions(workspaceId: string, from: Date, to: Date): Promise<DigestSessionRow[]>;
  listDecisions(workspaceId: string, from: Date, to: Date): Promise<DigestDecisionRow[]>;
  listArtifacts(workspaceId: string, from: Date, to: Date): Promise<DigestArtifactRow[]>;
  listOpenTasks(workspaceId: string): Promise<DigestTaskRow[]>;
}

function utcDayBounds(period: DigestPeriod): { from: Date; to: Date } {
  const from = new Date(`${period.day}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error(`invalid digest day: ${period.day}`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

function truncateLine(input: string, max = 140): string {
  const oneLine = input.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

function shortSha(sha: string | null | undefined): string | undefined {
  return sha ? sha.slice(0, 7) : undefined;
}

function sessionTitle(s: DigestSessionRow): string {
  const head = truncateLine(s.result || s.command);
  const ref = shortSha(s.headSha);
  return ref ? `${head} (${ref})` : head;
}

function taskSeverity(status: string): BlockerSeverity {
  return status === "blocked" ? "high" : "medium";
}

function artifactSummary(a: DigestArtifactRow): string {
  const detail = truncateLine(a.detail || `${a.provider} ${a.tool}`);
  return detail || `${a.tool} via ${a.provider}`;
}

function isPublishedArtifact(a: DigestArtifactRow): boolean {
  return a.status === "published" || a.status === "pending_approval";
}

function isBlockingArtifact(a: DigestArtifactRow): boolean {
  return a.status === "blocked" || a.status === "failed";
}

function ensureAgent(map: Map<string, AgentActivityInput>, ref: DigestAgentRef): AgentActivityInput {
  const existing = map.get(ref.id);
  if (existing) return existing;
  const next: AgentActivityInput = {
    agentId: ref.id,
    agentName: ref.name,
    role: ref.role ?? undefined,
    artifacts: [],
    decisions: [],
    blockers: [],
    planned: [],
  };
  map.set(ref.id, next);
  return next;
}

/**
 * Repository-backed source for the real daily digest. It reads already-durable product data: sessions,
 * decisions, real-world artifacts, and tasks. The synthesized digest can therefore replace raw-log reading
 * instead of summarizing a demo roster.
 */
export class RepositoryDailyActivitySource implements DailyActivitySource {
  constructor(private readonly deps: RepositoryDailyActivitySourceDeps) {}

  async fetch(workspaceId: string, period: DigestPeriod): Promise<DailyActivityData> {
    const { from, to } = utcDayBounds(period);
    const [agents, sessions, decisions, artifacts, tasks] = await Promise.all([
      this.deps.listAgents(workspaceId),
      this.deps.listSessions(workspaceId, from, to),
      this.deps.listDecisions(workspaceId, from, to),
      this.deps.listArtifacts(workspaceId, from, to),
      this.deps.listOpenTasks(workspaceId),
    ]);

    const byAgent = new Map<string, AgentActivityInput>();
    for (const agent of agents) ensureAgent(byAgent, agent);

    const fallbackAgent = (id: string | null | undefined, name?: string | null): AgentActivityInput =>
      ensureAgent(byAgent, {
        id: id || "workspace-unassigned",
        name: name || (id ? `Agent ${id.slice(0, 8)}` : "Unassigned work"),
        role: id ? "agent" : "workspace",
      });

    for (const s of sessions) {
      const agent = fallbackAgent(s.agentMemberId, s.agentName);
      const receipt = { label: "Session", url: `/workspaces/${workspaceId}/agent-sessions/${s.id}` };
      if (s.status === "completed") {
        agent.artifacts.push({
          id: `session:${s.id}`,
          title: sessionTitle(s),
          kind: "session",
          receipt,
        });
      } else if (["failed", "timeout", "idle_reaped", "canceled"].includes(s.status)) {
        agent.blockers.push({
          id: `session:${s.id}`,
          summary: `${s.status.replace("_", " ")}: ${truncateLine(s.result || s.command)}`,
          severity: s.status === "failed" || s.status === "timeout" ? "high" : "medium",
          receipt,
        });
      } else {
        agent.planned.push({
          id: `session:${s.id}`,
          summary: `${s.status}: ${truncateLine(s.command)}`,
          receipt,
        });
      }
    }

    for (const d of decisions) {
      fallbackAgent(d.decidedByMemberId).decisions.push({
        id: `decision:${d.id}`,
        summary: truncateLine(d.title || d.rationale || "Recorded decision"),
        receipt: { label: "Decision", url: `/workspaces/${workspaceId}/decisions/${d.id}` },
      });
    }

    const fleet = ensureAgent(byAgent, { id: "workspace-artifacts", name: "Workspace artifacts", role: "fleet" });
    for (const a of artifacts) {
      const receipt = { label: "Artifact", url: a.url || `/workspaces/${workspaceId}/realworld-artifacts/${a.id}` };
      if (isPublishedArtifact(a)) {
        fleet.artifacts.push({
          id: `artifact:${a.id}`,
          title: artifactSummary(a),
          kind: a.tool,
          receipt,
        });
      } else if (isBlockingArtifact(a)) {
        fleet.blockers.push({
          id: `artifact:${a.id}`,
          summary: `${a.status}: ${artifactSummary(a)}`,
          severity: a.status === "failed" ? "high" : "medium",
          receipt,
        });
      }
    }

    for (const t of tasks) {
      const agent = fallbackAgent(t.assigneeMemberId);
      const receipt = { label: "Task", url: `/workspaces/${workspaceId}/tasks/${t.id}` };
      if (t.status === "blocked") {
        agent.blockers.push({
          id: `task:${t.id}`,
          summary: truncateLine(t.title),
          severity: taskSeverity(t.status),
          receipt,
        });
      } else {
        agent.planned.push({
          id: `task:${t.id}`,
          summary: truncateLine(t.title),
          receipt,
        });
      }
    }

    return {
      workspaceId,
      period,
      agents: [...byAgent.values()].filter(
        (a) => a.artifacts.length || a.decisions.length || a.blockers.length || a.planned.length,
      ),
    };
  }
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
