/**
 * Daily agent standup digest (issue #589) — domain types.
 *
 * The problem #589 fixes: the user can't tell at a glance what the team of agents accomplished or where it
 * is stuck — they would have to read raw logs. The fix is an auto-generated **daily digest, grouped by
 * agent**: what each agent shipped, the decisions it made, the blockers it hit, and what it plans next — with
 * working links to the receipts behind every entry.
 *
 * This file is the vocabulary shared by the three layers of the module:
 *   - the **input** the data-source seam supplies for a day ({@link DailyActivityData}),
 *   - the **pure synthesis** that turns that input into a digest (see `synthesize.ts`),
 *   - the **digest** itself ({@link DailyDigest}), which the store persists and the renderer prints.
 *
 * Everything here is plain data — no IO, no clock, no DB — so the synthesis core stays pure and deterministic.
 */

/** The single calendar day a digest covers. ISO `YYYY-MM-DD` (UTC) — no clock dependency. */
export interface DigestPeriod {
  /** The day the digest summarizes, `YYYY-MM-DD`. */
  day: string;
}

/**
 * A link to the receipt backing an activity entry (a PR, a doc, a trace, a deliverable). The acceptance
 * criterion requires "working links", so the synthesis core validates and normalizes these — see
 * `normalizeLink` in `synthesize.ts` — and drops any that are malformed rather than emitting a dead link.
 */
export interface ReceiptLink {
  /** Human label for the link, e.g. "PR #762" or "Campaign brief". */
  label: string;
  /** The URL — an absolute `http(s)` URL or a site-relative path starting with `/`. */
  url: string;
}

/** An artifact an agent shipped during the day (the "what they did" — concrete, finished output). */
export interface ShippedArtifact {
  id: string;
  /** Short title, e.g. "Merged PR #762: agent garden default-on". */
  title: string;
  /** Optional kind, e.g. `pr`, `doc`, `campaign`, `deploy`, `report`. */
  kind?: string;
  /** Link to the receipt for this artifact. Optional but strongly encouraged. */
  receipt?: ReceiptLink;
}

/** A decision an agent made during the day (also "what they did", but reasoning rather than output). */
export interface AgentDecision {
  id: string;
  /** One-line summary of the decision, e.g. "Chose linear attribution over position-based". */
  summary: string;
  receipt?: ReceiptLink;
}

/** How blocking a blocker is — used to rank which stuck agents need attention first. */
export type BlockerSeverity = "low" | "medium" | "high";

/** A blocker an agent hit during the day (the "where it's stuck" the issue calls out). */
export interface AgentBlocker {
  id: string;
  /** One-line summary of the blocker, e.g. "Waiting on Stripe API key approval". */
  summary: string;
  /** Severity; defaults to `medium` when the source omits it. */
  severity?: BlockerSeverity;
  receipt?: ReceiptLink;
}

/** Something an agent plans to do next (the "what's next" / tomorrow's plan). */
export interface PlannedItem {
  id: string;
  /** One-line summary of the planned work, e.g. "Draft the Q3 launch announcement". */
  summary: string;
  receipt?: ReceiptLink;
}

/** Everything one agent did (and plans) for the day — the per-agent slice the source supplies. */
export interface AgentActivityInput {
  agentId: string;
  /** Human name, e.g. "Scout". */
  agentName: string;
  /** Optional role from the #586 role registry, e.g. `scout`, `writer`, `analyst`. */
  role?: string;
  /** Artifacts shipped today. */
  artifacts: ShippedArtifact[];
  /** Decisions made today. */
  decisions: AgentDecision[];
  /** Blockers hit today. */
  blockers: AgentBlocker[];
  /** Planned next steps. */
  planned: PlannedItem[];
}

/** Everything the data-source provides for one workspace-day — the sole input to the pure synthesis. */
export interface DailyActivityData {
  workspaceId: string;
  period: DigestPeriod;
  agents: AgentActivityInput[];
}

/** An agent's status for the day, derived from its activity. */
export type AgentStatus = "shipping" | "blocked" | "planning" | "idle";

/** One agent's standup section after synthesis — "what they did + what's next", with counts and links. */
export interface AgentStandup {
  agentId: string;
  agentName: string;
  role?: string;
  status: AgentStatus;
  /** A one-line synthesis: what they did + what's next. */
  summary: string;
  /** The artifacts shipped (capped + link-normalized). */
  shipped: ShippedArtifact[];
  /** The decisions made (capped + link-normalized). */
  decisions: AgentDecision[];
  /** The blockers hit (capped + link-normalized), highest severity first. */
  blockers: AgentBlocker[];
  /** What's next (capped + link-normalized). */
  next: PlannedItem[];
  shippedCount: number;
  decisionCount: number;
  blockerCount: number;
  plannedCount: number;
  /** Numeric activity score used to rank agents within the digest. */
  activityScore: number;
  /** Every valid receipt link from this agent's entries, deduped — the agent's working links. */
  links: ReceiptLink[];
}

/** Roll-up counts across all agents for the day. */
export interface DigestTotals {
  /** Total agents reported. */
  agents: number;
  /** Agents with any activity (shipped/decided/blocked/planned). */
  activeAgents: number;
  /** Agents with at least one blocker. */
  blockedAgents: number;
  shipped: number;
  decisions: number;
  blockers: number;
  planned: number;
}

/** The synthesized daily standup digest — what gets persisted, rendered, and shown to the user. */
export interface DailyDigest {
  workspaceId: string;
  period: DigestPeriod;
  /** A one-line synthesis of the whole team's day. */
  headline: string;
  /** Per-agent standups, ranked (agents needing attention first, then most active). */
  agents: AgentStandup[];
  totals: DigestTotals;
  /** Every valid receipt link across all agents, deduped — guarantees the "working links" criterion. */
  links: ReceiptLink[];
}
