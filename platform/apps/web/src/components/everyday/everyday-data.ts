/**
 * Pure data + types for the everyday workspace shell (#784). The shell is presentational: it renders these
 * typed shapes and reads every label/button/empty-state word from `EVERYDAY` in brand.ts. This module owns
 * the shapes, a couple of pure helpers (time-of-day greeting bucket, number formatting), an empty live-state
 * fallback, and an explicit realistic seed dataset for tests/demo previews only.
 *
 * Keeping it pure (no React, no DOM) means every branch is unit-tested directly. Agent output text and
 * deliverable bodies in the seed are DATA (what an agent actually produced), not product chrome, so they
 * live here rather than in brand.ts — the chrome voice (headings, buttons, nudges) stays in EVERYDAY.
 */

/** The north star: customers + revenue, front and centre (#630). Numbers are data; trend drives the copy. */
export interface NorthStar {
  readonly customers: number;
  readonly customersDelta: number;
  /** Pre-formatted revenue string (e.g. "$2,480") so the shell never guesses a currency. */
  readonly revenue: string;
  readonly revenueDelta: string;
  readonly trend: "up" | "flat" | "zero";
}

/** A visible room lane: Tomo-simple start, reload.chat-style multi-agent coworking once it begins. */
export interface AgentLane {
  readonly id: string;
  readonly agent: string;
  readonly role: string;
  readonly status: "idle" | "working" | "blocked" | "done" | "codex";
  readonly task: string;
}

/** A first-run account connector, grouped like Tomo's direct connect page but backed by ipop's Connections surface. */
export interface EverydayConnector {
  readonly id: string;
  readonly group: "productivity" | "marketing" | "publishing" | "visibility";
  readonly name: string;
  readonly status: "connected" | "available" | "coming_soon" | "blocked" | "pending";
  readonly detail: string;
  readonly actionLabel: string;
}

/**
 * What a connector "connect" click actually did (#1551). The shell uses this to give every click honest,
 * visible feedback instead of a silent no-op: `redirecting` means the page is handing off to an OAuth/setup
 * screen, `connected`/`pending` mean a one-click channel turned on, `waitlisted` means a not-live connector
 * recorded interest, and `imessage` points at the dedicated recipient panel rendered above the catalog.
 */
export type EverydayConnectorConnectOutcome =
  | "redirecting"
  | "connected"
  | "pending"
  | "waitlisted"
  | "imessage"
  | "noop";

export interface EverydayConnectorConnectResult {
  readonly outcome: EverydayConnectorConnectOutcome;
}

/** An inline artifact that landed in the thread or awaits approval — a draft or a before/after diff. */
export interface Deliverable {
  readonly title: string;
  readonly kind: "draft" | "diff";
  /** For a draft: the work product. For a diff: the "after" text. */
  readonly preview: string;
  /** For a diff only: the "before" text, shown above the after. */
  readonly before?: string;
}

/** A line in the calm thread: either an agent narrating, or a deliverable landing inline. */
export type ThreadEntry =
  | {
      readonly id: string;
      readonly teamRunId?: string;
      readonly kind: "agent-line";
      readonly agent: string;
      readonly at: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly teamRunId?: string;
      readonly kind: "deliverable";
      readonly agent: string;
      readonly at: string;
      readonly deliverable: Deliverable;
    };

/** A ship-decision card: the FINISHED deliverable + the one consequence of approving — never chatter. */
export interface ApprovalCard {
  readonly id: string;
  /** The real #13 approval request this card decides. */
  readonly approvalRequestId: string;
  readonly agent: string;
  readonly deliverable: Deliverable;
  /** Verb phrase completing "approve and we'll …" (e.g. "send this to 3 warm leads"). */
  readonly consequence: string;
  /** True when approving spends real money — the one hard gate. */
  readonly costsMoney: boolean;
  /** Pre-formatted spend (e.g. "$40"), shown only when costsMoney. */
  readonly amount?: string;
}

/** A timestamped external action with a required receipt link for the quiet transparency log (#625/#629). */
export interface ExternalAction {
  readonly id: string;
  /** Pre-formatted, human time (e.g. "2:14 pm"). */
  readonly at: string;
  /** What we did, plainly (e.g. "replied to a warm lead in gmail"). */
  readonly action: string;
  /** Required link to the real artifact out in the world: live URL, sent email, signup record, etc. */
  readonly href: string;
  /** Optional receipt-specific link text when "see it" is too vague. */
  readonly receiptLabel?: string;
  /** One-click reversal when the public action is reversible (e.g. unpublish/delete). */
  readonly undoLabel?: string;
}

export interface MarketingMetric {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: "good" | "warn" | "bad" | "neutral";
  readonly proofKind: "live" | "sample" | "external";
  readonly proof: string;
}

export interface LaunchReadinessItem {
  readonly label: "auth" | "connectors" | "first run" | "outbound" | "billing" | "observability" | "legal/trust";
  readonly status: "ready" | "blocked" | "pending";
  readonly proof: string;
}

export interface MarketingChannel {
  readonly source: string;
  readonly status: string;
  readonly pipeline: string;
  readonly conversion: string;
  readonly spend: string;
  readonly next: string;
}

export interface MarketingAction {
  readonly title: string;
  readonly owner: string;
  readonly proof: string;
}

export interface MarketingGoal {
  readonly label: string;
  readonly target: string;
  readonly current: string;
  readonly pace: string;
  readonly confidence: "high" | "medium" | "low";
}

export interface MarketingWorkItem {
  readonly agent: string;
  readonly work: string;
  readonly impact: string;
  readonly status: "shipped" | "queued" | "blocked" | "learning";
  readonly proof: string;
}

export interface ExecutiveSignal {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: "good" | "warn" | "bad" | "neutral";
  readonly proof: string;
}

export interface MarketingFunnelStage {
  readonly label: string;
  readonly count: string;
  readonly detail: string;
  readonly tone: "good" | "warn" | "bad" | "neutral";
}

export interface MarketingBrief {
  readonly mode: "live" | "sample";
  readonly headline: string;
  readonly executiveSummary: readonly ExecutiveSignal[];
  readonly sinceLastCheckIn: readonly MarketingAction[];
  readonly goal: MarketingGoal;
  readonly metrics: readonly MarketingMetric[];
  readonly rankedWork: readonly MarketingWorkItem[];
  readonly capacity: readonly ExecutiveSignal[];
  readonly funnel: readonly MarketingFunnelStage[];
  readonly channels: readonly MarketingChannel[];
  readonly blockers: readonly MarketingAction[];
  readonly decisions: readonly MarketingAction[];
  readonly nextActions: readonly MarketingAction[];
  readonly readiness: readonly LaunchReadinessItem[];
}

/** Everything the everyday shell renders. */
export interface EverydayData {
  readonly memberName: string;
  readonly northStar: NorthStar;
  readonly room: readonly AgentLane[];
  readonly connectors: readonly EverydayConnector[];
  readonly thread: readonly ThreadEntry[];
  readonly approvals: readonly ApprovalCard[];
  readonly transparency: readonly ExternalAction[];
  /** The kill-switch is always on; this is just whether the fleet is currently running or paused. */
  readonly fleetPaused: boolean;
  readonly marketingBrief?: MarketingBrief;
}

/** Time-of-day bucket for the greeting. Pure: takes the local hour (0–23) so it is trivially testable. */
export function partOfDay(hour: number): "morning" | "afternoon" | "evening" {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Compact integer formatting for the north-star customer count (1,200 → "1.2k"). Pure. */
export function compactCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const v = Math.trunc(n);
  if (Math.abs(v) < 1000) return String(v);
  const k = v / 1000;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

/** A signed delta string for a count (e.g. +3 → "+3", 0 → "—"). Pure. */
export function signedDelta(n: number): string {
  const v = Math.trunc(n);
  if (v === 0) return "—";
  return v > 0 ? `+${v}` : String(v);
}

/** Empty live workspace state: honest zeros and empty sections, never sample wins. */
export function emptyEverydayData(memberName: string = "there"): EverydayData {
  return {
    memberName,
    northStar: {
      customers: 0,
      customersDelta: 0,
      revenue: "$0",
      revenueDelta: "—",
      trend: "zero",
    },
    room: defaultAgentRoom("your next customer"),
    connectors: defaultConnectors(),
    thread: [],
    approvals: [],
    transparency: [],
    fleetPaused: false,
    marketingBrief: {
      mode: "live",
      headline:
        "No marketing signal yet. Start the room and the team should fill this with live work, connected channels, and what needs your review.",
      executiveSummary: [
        { label: "visible work", value: "0", detail: "no thread or receipt activity yet", tone: "bad", proof: "empty live workspace" },
        { label: "new customers", value: "0", detail: "no lead source connected", tone: "bad", proof: "empty live workspace" },
        { label: "needs your review", value: "0", detail: "nothing queued for owner review", tone: "neutral", proof: "empty approval queue" },
        { label: "channels to connect", value: "all", detail: "connect one real acquisition source", tone: "bad", proof: "connector catalog has no live channel" },
      ],
      sinceLastCheckIn: [
        { title: "No measurable workspace change yet", owner: "Operator", proof: "no thread, approval, or receipt activity" },
      ],
      goal: {
        label: "customer goal",
        target: "set by owner",
        current: "0 customers",
        pace: "no target or source connected",
        confidence: "low",
      },
      metrics: [
        { label: "leads found", value: "0", detail: "no prospect source connected", tone: "bad", proofKind: "live", proof: "empty live workspace" },
        { label: "good-fit leads", value: "0", detail: "no lead scoring run yet", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "replies", value: "0", detail: "no outbound channel proven", tone: "bad", proofKind: "live", proof: "empty live workspace" },
        { label: "customers", value: "0", detail: "no won customer recorded", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "spend", value: "$0", detail: "no paid campaigns live", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "roi", value: "—", detail: "needs revenue + spend", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
      ],
      rankedWork: [
        {
          agent: "Scout",
          work: "waiting for the first source read",
          impact: "no usable insight ranked yet",
          status: "blocked",
          proof: "empty live workspace",
        },
        {
          agent: "Echo",
          work: "waiting for one real acquisition channel",
          impact: "no customer-facing distribution can happen",
          status: "blocked",
          proof: "no provider receipt connected",
        },
      ],
      capacity: [
        { label: "campaigns running", value: "0 / 1", detail: "brief one campaign before upgrading", tone: "neutral", proof: "starter lane is unused" },
        { label: "team members active", value: "0 / 5", detail: "room has not started", tone: "neutral", proof: "no active team packet" },
        { label: "monthly work budget", value: "$0 / $200", detail: "upgrade only after useful work is queued", tone: "neutral", proof: "no spend or work receipt yet" },
      ],
      funnel: [
        { label: "audience read", count: "0", detail: "no site/source crawl receipt", tone: "bad" },
        { label: "best-fit customers ranked", count: "0", detail: "no shortlist of who to reach yet", tone: "bad" },
        { label: "messages drafted", count: "0", detail: "waiting on a brief", tone: "neutral" },
        { label: "sent", count: "0", detail: "approval-gated until a real channel exists", tone: "bad" },
        { label: "won", count: "0", detail: "no customer proof", tone: "bad" },
      ],
      channels: [
        {
          source: "owned site",
          status: "needs conversion proof",
          pipeline: "0 qualified leads",
          conversion: "—",
          spend: "$0",
          next: "start with one live site read and one measurable CTA",
        },
      ],
      blockers: [
        {
          title: "Team-engine auth not proven",
          owner: "Operator",
          proof: "agent room cannot claim real work without runtime proof",
        },
        {
          title: "External channels not connected",
          owner: "Echo",
          proof: "no outbound send path has an end-to-end receipt",
        },
      ],
      decisions: [
        {
          title: "Choose one first growth target",
          owner: "You",
          proof: "customer segment, channel, and success number",
        },
      ],
      nextActions: [
        {
          title: "Connect one real acquisition channel",
          owner: "Echo",
          proof: "move one lead from found to contacted with a receipt",
        },
        {
          title: "Replace demo dashboard data with live workspace metrics",
          owner: "Lens",
          proof: "dashboard must come from live workspace rows, not copy",
        },
      ],
      readiness: [
        { label: "auth", status: "blocked", proof: "no signed-in team-engine proof yet" },
        { label: "connectors", status: "blocked", proof: "no provider receipt connected" },
        { label: "first run", status: "pending", proof: "waiting for first customer site-read receipt" },
        { label: "outbound", status: "blocked", proof: "no real send path receipt" },
        { label: "billing", status: "pending", proof: "pricing exists; activation limits need live plan data" },
        { label: "observability", status: "pending", proof: "no agent health/audit feed on this dashboard" },
        { label: "legal/trust", status: "pending", proof: "legal links exist; customer-proof policy still needs enforcement" },
      ],
    },
  };
}

export function defaultAgentRoom(goal: string): readonly AgentLane[] {
  const target = goal.trim() || "your next customer";
  return [
    {
      id: "scout",
      agent: "Scout",
      role: "ICP + SEO",
      status: "working",
      task: "Researching " + target + " and the people most likely to care.",
    },
    {
      id: "quill",
      agent: "Quill",
      role: "Content",
      status: "idle",
      task: "Waiting for Scout's first notes, then drafting the angle.",
    },
    {
      id: "echo",
      agent: "Echo",
      role: "Outbound",
      status: "idle",
      task: "Standing by for target accounts and a human-approved send path.",
    },
    {
      id: "lens",
      agent: "Lens",
      role: "Brand",
      status: "idle",
      task: "Keeping the whole thing warm, plain, and not weird.",
    },
    {
      id: "codex",
      agent: "Operator",
      role: "Operator",
      status: "codex",
      task: "Turning approved decisions into product/code execution after the team agrees what should ship.",
    },
  ];
}

export function defaultConnectors(): readonly EverydayConnector[] {
  return [
    {
      id: "email",
      group: "productivity",
      name: "Email",
      status: "available",
      detail: "email, replies, and follow-up receipts.",
      actionLabel: "connect",
    },
    {
      id: "web_room",
      group: "visibility",
      name: "Web room",
      status: "available",
      detail: "the signed-in ipop room is the canonical transcript while external chat bridges come online.",
      actionLabel: "connect",
    },
    {
      id: "imessage",
      group: "visibility",
      name: "iMessage",
      status: "coming_soon",
      detail: "the primary home for agent work visibility once the Apple Messages relay is production-ready.",
      actionLabel: "set up iMessage",
    },
    {
      id: "whatsapp_room",
      group: "visibility",
      name: "WhatsApp room",
      status: "coming_soon",
      detail: "requires a verified WhatsApp sender and signed webhook loop before agents can use it.",
      actionLabel: "notify me",
    },
    {
      id: "telegram_room",
      group: "visibility",
      name: "Telegram room",
      status: "coming_soon",
      detail: "requires a verified bot and signed webhook loop before agents can use it.",
      actionLabel: "notify me",
    },
    {
      id: "google",
      group: "productivity",
      status: "coming_soon",
      name: "Google",
      detail: "Search Console + Analytics when Google OAuth is live.",
      actionLabel: "notify me",
    },
    {
      id: "website",
      group: "publishing",
      name: "Website",
      status: "available",
      detail: "approved pages can go live, not just to preview.",
      actionLabel: "connect",
    },
    {
      id: "social_aggregator",
      group: "marketing",
      name: "Social accounts",
      status: "available",
      detail: "research public threads and draft owner-approved replies.",
      actionLabel: "connect",
    },
    {
      id: "linkedin",
      group: "marketing",
      name: "LinkedIn",
      status: "coming_soon",
      detail: "native LinkedIn posting is not live yet.",
      actionLabel: "notify me",
    },
  ];
}
