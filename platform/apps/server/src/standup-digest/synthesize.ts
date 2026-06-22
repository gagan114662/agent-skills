/**
 * Daily agent standup digest — the **pure synthesis core** (issue #589).
 *
 * `synthesizeDailyDigest` is a deterministic, side-effect-free function from one day's raw per-agent activity
 * to a finished {@link DailyDigest}: it groups by agent, classifies each agent's status, writes a one-line
 * "what they did + what's next" summary, ranks the agents (those needing attention first, then most active),
 * rolls up team totals, and — the heart of the acceptance criterion — collects **working links** to every
 * receipt, dropping any malformed URL rather than emitting a dead link.
 *
 * No IO, no clock, no randomness: given the same {@link DailyActivityData} it always produces the same digest,
 * which is what makes the whole module unit-testable with no database and no network (the #17
 * pure-decision + injected-seam pattern). The service layer (`service.ts`) supplies the data and persists the
 * result; this file only thinks.
 */

import type {
  AgentActivityInput,
  AgentBlocker,
  AgentStandup,
  AgentStatus,
  DailyActivityData,
  DailyDigest,
  DigestTotals,
  ReceiptLink,
} from "./types.js";

/** Per-entry weights for the activity score that ranks agents. Shipping counts most; idle planning least. */
export const ACTIVITY_WEIGHTS = {
  shipped: 3,
  decision: 2,
  blocker: 2,
  planned: 1,
} as const;

/** Severity order used to surface the most blocking blockers first. */
const SEVERITY_RANK: Record<NonNullable<AgentBlocker["severity"]>, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Validate + normalize a receipt link. Returns the trimmed link only when its URL is a well-formed absolute
 * `http(s)` URL or a site-relative path (starts with a single `/`); otherwise returns null. This is what
 * makes the digest's links "working" — a malformed or empty URL is dropped, never rendered as a dead link.
 */
export function normalizeLink(link: ReceiptLink | undefined): ReceiptLink | null {
  if (!link) return null;
  const url = link.url.trim();
  const label = link.label.trim();
  if (url.length === 0 || label.length === 0) return null;
  const isHttp = /^https?:\/\/[^\s]+$/i.test(url);
  // Site-relative path: a single leading slash (rejects `//host` protocol-relative URLs).
  const isRelative = url.startsWith("/") && !url.startsWith("//");
  if (!isHttp && !isRelative) return null;
  return { label, url };
}

/** Strip a link off an entry if it is malformed, leaving the entry's other fields untouched. */
function withNormalizedLink<T extends { receipt?: ReceiptLink }>(entry: T): T {
  const receipt = normalizeLink(entry.receipt);
  return receipt ? { ...entry, receipt } : ({ ...entry, receipt: undefined } as T);
}

/** Dedupe links by `url` (first label wins), preserving insertion order. */
function dedupeLinks(links: ReceiptLink[]): ReceiptLink[] {
  const seen = new Set<string>();
  const out: ReceiptLink[] = [];
  for (const l of links) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
  }
  return out;
}

/** Classify an agent's day from its counts. Shipping wins over blocked (progress was still made). */
function statusFor(shipped: number, decisions: number, blockers: number, planned: number): AgentStatus {
  if (shipped > 0 || decisions > 0) return "shipping";
  if (blockers > 0) return "blocked";
  if (planned > 0) return "planning";
  return "idle";
}

/** Sort blockers by severity (high → low), keeping insertion order within a severity (stable). */
function rankBlockers(blockers: AgentBlocker[]): AgentBlocker[] {
  return blockers
    .map((b, i) => ({ b, i }))
    .sort((x, y) => SEVERITY_RANK[x.b.severity ?? "medium"] - SEVERITY_RANK[y.b.severity ?? "medium"] || x.i - y.i)
    .map(({ b }) => b);
}

/** Build the one-line "what they did + what's next" summary for an agent. */
function summarize(agent: AgentActivityInput): string {
  const parts: string[] = [];

  if (agent.artifacts.length > 0) {
    const first = agent.artifacts[0]?.title ?? "work";
    const more = agent.artifacts.length - 1;
    parts.push(`shipped ${agent.artifacts.length} (${first}${more > 0 ? ` +${more} more` : ""})`);
  }
  if (agent.decisions.length > 0) {
    parts.push(`made ${agent.decisions.length} decision${agent.decisions.length === 1 ? "" : "s"}`);
  }
  if (agent.blockers.length > 0) {
    const first = agent.blockers[0]?.summary ?? "an issue";
    parts.push(`blocked on ${agent.blockers.length} (${first})`);
  }

  const didPart = parts.length > 0 ? parts.join("; ") : "no recorded activity";
  const nextPart =
    agent.planned.length > 0
      ? ` Next: ${agent.planned[0]?.summary ?? "TBD"}${agent.planned.length > 1 ? ` (+${agent.planned.length - 1} more)` : ""}.`
      : " Next: nothing planned.";
  return `${didPart}.${nextPart}`;
}

/** Turn one agent's raw activity into its synthesized standup section. Pure. */
export function buildAgentStandup(agent: AgentActivityInput, maxItemsPerSection: number): AgentStandup {
  const cap = Math.max(1, Math.trunc(maxItemsPerSection));

  const shippedCount = agent.artifacts.length;
  const decisionCount = agent.decisions.length;
  const blockerCount = agent.blockers.length;
  const plannedCount = agent.planned.length;

  const shipped = agent.artifacts.slice(0, cap).map(withNormalizedLink);
  const decisions = agent.decisions.slice(0, cap).map(withNormalizedLink);
  const blockers = rankBlockers(agent.blockers).slice(0, cap).map(withNormalizedLink);
  const next = agent.planned.slice(0, cap).map(withNormalizedLink);

  // Collect links from ALL entries (not just the capped slice) so the agent's link set is complete.
  const links = dedupeLinks(
    [...agent.artifacts, ...agent.decisions, ...agent.blockers, ...agent.planned]
      .map((e) => normalizeLink(e.receipt))
      .filter((l): l is ReceiptLink => l !== null),
  );

  const activityScore =
    shippedCount * ACTIVITY_WEIGHTS.shipped +
    decisionCount * ACTIVITY_WEIGHTS.decision +
    blockerCount * ACTIVITY_WEIGHTS.blocker +
    plannedCount * ACTIVITY_WEIGHTS.planned;

  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    role: agent.role,
    status: statusFor(shippedCount, decisionCount, blockerCount, plannedCount),
    summary: summarize(agent),
    shipped,
    decisions,
    blockers,
    next,
    shippedCount,
    decisionCount,
    blockerCount,
    plannedCount,
    activityScore,
    links,
  };
}

/**
 * Rank agents for display. Agents with blockers come first (the "where it's stuck" the issue asks to
 * surface), then by activity score (desc), then by name then id for a stable, deterministic order.
 */
function rankAgents(a: AgentStandup, b: AgentStandup): number {
  const aAttention = a.blockerCount > 0 ? 0 : 1;
  const bAttention = b.blockerCount > 0 ? 0 : 1;
  if (aAttention !== bAttention) return aAttention - bAttention;
  if (a.activityScore !== b.activityScore) return b.activityScore - a.activityScore;
  if (a.agentName !== b.agentName) return a.agentName < b.agentName ? -1 : 1;
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}

function rollUp(agents: AgentStandup[]): DigestTotals {
  const totals: DigestTotals = {
    agents: agents.length,
    activeAgents: 0,
    blockedAgents: 0,
    shipped: 0,
    decisions: 0,
    blockers: 0,
    planned: 0,
  };
  for (const a of agents) {
    if (a.status !== "idle") totals.activeAgents += 1;
    if (a.blockerCount > 0) totals.blockedAgents += 1;
    totals.shipped += a.shippedCount;
    totals.decisions += a.decisionCount;
    totals.blockers += a.blockerCount;
    totals.planned += a.plannedCount;
  }
  return totals;
}

function buildHeadline(day: string, totals: DigestTotals): string {
  const base =
    `Daily standup for ${day}: ${totals.activeAgents}/${totals.agents} agents active, ` +
    `${totals.shipped} shipped, ${totals.decisions} decision${totals.decisions === 1 ? "" : "s"}`;
  const blockerPart =
    totals.blockers > 0
      ? `, ⚠️ ${totals.blockers} blocker${totals.blockers === 1 ? "" : "s"} across ${totals.blockedAgents} agent${totals.blockedAgents === 1 ? "" : "s"}`
      : ", no blockers";
  return `${base}${blockerPart}.`;
}

/**
 * Synthesize a day's raw per-agent activity into a finished {@link DailyDigest}. Pure and deterministic — the
 * single function the service calls to produce the digest's body.
 */
export function synthesizeDailyDigest(data: DailyActivityData, maxItemsPerSection = 5): DailyDigest {
  const agents = data.agents.map((a) => buildAgentStandup(a, maxItemsPerSection)).sort(rankAgents);
  const totals = rollUp(agents);
  const links = dedupeLinks(agents.flatMap((a) => a.links));
  const headline = buildHeadline(data.period.day, totals);
  return {
    workspaceId: data.workspaceId,
    period: data.period,
    headline,
    agents,
    totals,
    links,
  };
}
