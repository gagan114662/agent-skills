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
      readonly kind: "agent-line";
      readonly agent: string;
      readonly at: string;
      readonly text: string;
    }
  | {
      readonly id: string;
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
  readonly proofKind: "live" | "sample" | "dogfood" | "external";
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
        "No marketing signal yet. Start the room and the team should fill this with pipeline, channel, spend, and blocker data.",
      executiveSummary: [
        { label: "work shipped today", value: "0", detail: "no thread or receipt activity yet", tone: "bad", proof: "empty live workspace" },
        { label: "pipeline moved", value: "0", detail: "no lead source connected", tone: "bad", proof: "empty live workspace" },
        { label: "approvals waiting", value: "0", detail: "nothing queued for owner review", tone: "neutral", proof: "empty approval queue" },
        { label: "blocked channels", value: "all", detail: "connect one real acquisition source", tone: "bad", proof: "connector catalog has no live channel" },
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
        { label: "qualified", value: "0", detail: "no ICP scoring run yet", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "replies", value: "0", detail: "no outbound channel proven", tone: "bad", proofKind: "live", proof: "empty live workspace" },
        { label: "customers", value: "0", detail: "no won customer recorded", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "spend", value: "$0", detail: "no paid campaigns live", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
        { label: "roi", value: "—", detail: "needs revenue + spend", tone: "neutral", proofKind: "live", proof: "empty live workspace" },
      ],
      capacity: [
        { label: "active campaign lanes", value: "0 / 1", detail: "brief one campaign before upgrading", tone: "neutral", proof: "starter lane is unused" },
        { label: "agent seats used", value: "0 / 3", detail: "room has not started", tone: "neutral", proof: "no active team packet" },
        { label: "monthly work cap", value: "$0 / $200", detail: "upgrade only after useful work is queued", tone: "neutral", proof: "no spend or work receipt yet" },
      ],
      funnel: [
        { label: "audience read", count: "0", detail: "no site/source crawl receipt", tone: "bad" },
        { label: "ICP ranked", count: "0", detail: "no scored segment list", tone: "bad" },
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
          proof: "CMO brief must come from source rows, not copy",
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

/**
 * A realistic seed dataset for explicit demos/tests. Voice-rich and concrete so a labelled preview can read like
 * a real, working product (the whole point of #784). The signed-in app shell must pass live workspace data instead
 * of relying on this seed. The chrome copy is still sourced
 * from EVERYDAY — only the agent output / deliverable bodies (genuine work product) live here.
 */
export function seedEveryday(memberName: string = "gagan"): EverydayData {
  return {
    memberName,
    northStar: {
      customers: 14,
      customersDelta: 3,
      revenue: "$2,480",
      revenueDelta: "+$640",
      trend: "up",
    },
    fleetPaused: false,
    room: [
      {
        id: "scout",
        agent: "Scout",
        role: "Insight",
        status: "working",
        task: "Mining the brand, category, product, and customer tensions before anyone writes a line.",
      },
      {
        id: "quill",
        agent: "Quill",
        role: "Creative",
        status: "done",
        task: "Turning the strongest validated insight into a campaign platform and first asset.",
      },
      {
        id: "echo",
        agent: "Echo",
        role: "Distribution",
        status: "blocked",
        task: "Found warm channels; waiting for send approval before anything leaves Messages.",
      },
      {
        id: "lens",
        agent: "Lens",
        role: "Brand",
        status: "working",
        task: "Checking the work against award-winning references, not generic AI slop.",
      },
      {
        id: "codex",
        agent: "Operator",
        role: "Operator",
        status: "codex",
        task: "Turning approved decisions into implementation work once the team agrees what should ship.",
      },
    ],
    connectors: [
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
        id: "gmail",
        group: "productivity",
        name: "Gmail",
        status: "connected",
        detail: "gagan@getfoolish.com",
        actionLabel: "connect",
      },
      {
        id: "calendar",
        group: "productivity",
        name: "Google Calendar",
        status: "available",
        detail: "let the room see launch dates and follow-ups.",
        actionLabel: "connect",
      },
      {
        id: "drive",
        group: "productivity",
        name: "Google Drive",
        status: "available",
        detail: "brand docs, case studies, and proof in one place.",
        actionLabel: "connect",
      },
      {
        id: "linkedin",
        group: "marketing",
        name: "LinkedIn",
        status: "available",
        detail: "company research and human-approved outbound.",
        actionLabel: "connect",
      },
      {
        id: "site-publishing",
        group: "publishing",
        name: "Site publishing",
        status: "available",
        detail: "publish approved pages instead of stopping at previews.",
        actionLabel: "connect",
      },
    ],
    thread: [
      {
        id: "t1",
        kind: "agent-line",
        agent: "Scout",
        at: "9:02 am",
        text: "insight pass: your buyer is not asking for another marketing dashboard. they're asking to stop being the marketing department at 11:43 pm.",
      },
      {
        id: "t2",
        kind: "deliverable",
        agent: "Lens",
        at: "9:14 am",
        deliverable: {
          title: "category reference",
          kind: "diff",
          before: "show a dashboard with many agent cards.",
          preview: "borrow the Tomo move: one familiar texting behavior, then reveal the team doing serious work inside it.",
        },
      },
      {
        id: "t3",
        kind: "agent-line",
        agent: "Operator",
        at: "11:30 am",
        text: "I can turn the approved iMessage-first experience into product work. No separate API-key billing path needed for this lane.",
      },
      {
        id: "t4",
        kind: "deliverable",
        agent: "Quill",
        at: "11:31 am",
        deliverable: {
          title: "first campaign platform",
          kind: "draft",
          preview:
            "Text your marketing team. Watch Scout mine the insight, Lens protect the taste, Quill write the asset, Echo find distribution, and the operator ship the product work.",
        },
      },
    ],
    approvals: [
      {
        id: "a1",
        approvalRequestId: "apr_warm_lead_reply",
        agent: "Comet",
        deliverable: {
          title: "reply to a warm lead in your inbox",
          kind: "draft",
          preview:
            "Hi Dana — thanks for the kind words about the demo! Happy to set you up with a 14-day trial, no card needed. Want me to send the link, or hop on a quick call Thursday?",
        },
        consequence: "send this reply from your gmail to dana@northwind.co",
        costsMoney: false,
      },
      {
        id: "a2",
        approvalRequestId: "apr_launch_boost",
        agent: "Ada",
        deliverable: {
          title: "boosted post for the launch thread",
          kind: "draft",
          preview:
            "We just shipped the thing you asked for 47 times in our DMs. It's live. Link in the replies. 🚀",
        },
        consequence: "spend on a 3-day boost to ~8k people in your niche",
        costsMoney: true,
        amount: "$40",
      },
    ],
    transparency: [
      {
        id: "x1",
        at: "8:55 am",
        action: "read your site (ipop.ai) to learn the product",
        href: "https://ipop.ai",
        receiptLabel: "open site",
      },
      {
        id: "x4",
        at: "10:02 am",
        action: "published the launch page update",
        href: "https://ipop.ai/launch",
        receiptLabel: "open live page",
        undoLabel: "unpublish",
      },
      {
        id: "x2",
        at: "9:10 am",
        action: "sent the warm-lead reply to dana@northwind.co",
        href: "https://mail.google.com/mail/u/0/#sent/ipop-dana-northwind-trial",
        receiptLabel: "open sent email",
      },
      {
        id: "x5",
        at: "10:47 am",
        action: "recorded a new trial signup for Northwind",
        href: "https://dashboard.stripe.com/customers/cus_northwind_trial",
        receiptLabel: "open signup",
      },
      {
        id: "x3",
        at: "11:28 am",
        action: "read 3 public reddit threads in r/marketing",
        href: "https://reddit.com/r/marketing",
        receiptLabel: "open thread",
      },
    ],
  };
}

/** Public dogfood summary for /dashboard: actual ipop work receipts, not the Northwind/demo seed. */
export function ipopDogfoodEveryday(memberName: string = "gagan"): EverydayData {
  return {
    memberName,
    northStar: {
      customers: 0,
      customersDelta: 0,
      revenue: "$0",
      revenueDelta: "—",
      trend: "zero",
    },
    fleetPaused: false,
    room: [
      {
        id: "scout",
        agent: "Scout",
        role: "Product truth",
        status: "done",
        task: "Dogfooded ipop.ai against the Tomo-simple brief and found the old product path still felt like a demo.",
      },
      {
        id: "lens",
        agent: "Lens",
        role: "Taste",
        status: "done",
        task: "Kept the front door to one input, four icons, and marketing use-case tiles instead of another dense SaaS page.",
      },
      {
        id: "quill",
        agent: "Quill",
        role: "Experience",
        status: "done",
        task: "Turned the first-run path into site read -> visible agent work -> optional connectors -> site-read deliverable.",
      },
      {
        id: "echo",
        agent: "Echo",
        role: "Receipts",
        status: "working",
        task: "Keeping the dashboard tied to shipped work and PR receipts, not pretend customer proof.",
      },
      {
        id: "operator",
        agent: "Operator",
        role: "Ship",
        status: "working",
        task: "Merged the homepage, work-summary dashboard, and no-auth continuation fixes into production.",
      },
    ],
    connectors: defaultConnectors(),
    thread: [
      {
        id: "dogfood-home",
        kind: "deliverable",
        agent: "Lens",
        at: "merged",
        deliverable: {
          title: "Tomo-simple homepage",
          kind: "diff",
          before: "signed-in users saw the old workspace and prospects saw too much product explanation.",
          preview: "everyone lands on one clean message-first front door: Login, Love, Dashboard, Start, and marketing icons.",
        },
      },
      {
        id: "dogfood-dashboard",
        kind: "deliverable",
        agent: "Echo",
        at: "merged",
        deliverable: {
          title: "work summary dashboard",
          kind: "draft",
          preview:
            "the Dashboard icon opens a visible work summary instead of an auth wall, with receipts for what the team changed.",
        },
      },
      {
        id: "dogfood-skip",
        kind: "deliverable",
        agent: "Quill",
        at: "merged",
        deliverable: {
          title: "no-auth first deliverable path",
          kind: "draft",
          preview:
            "after the site read, users can skip connectors and still get a site-read draft; account-only work stays clearly gated.",
        },
      },
      {
        id: "dogfood-next",
        kind: "agent-line",
        agent: "Scout",
        at: "next",
        text: "next blocker: replace every remaining demo proof point with live workspace/customer evidence as connectors come online.",
      },
    ],
    approvals: [],
    transparency: [
      {
        id: "pr-1275",
        at: "merged",
        action: "simplified the ipop homepage to a message-first icon door",
        href: "https://github.com/gagan114662/agent-skills/pull/1275",
        receiptLabel: "PR #1275",
      },
      {
        id: "pr-1276",
        at: "merged",
        action: "added the public work-summary dashboard behind the Dashboard icon",
        href: "https://github.com/gagan114662/agent-skills/pull/1276",
        receiptLabel: "PR #1276",
      },
      {
        id: "pr-1277",
        at: "merged",
        action: "let onboarding continue to a site-read deliverable without Google/Gmail auth",
        href: "https://github.com/gagan114662/agent-skills/pull/1277",
        receiptLabel: "PR #1277",
      },
      {
        id: "live-dashboard",
        at: "live",
        action: "verified the production dashboard starts with work summary and no sign-in wall",
        href: "https://ipop.ai/dashboard",
        receiptLabel: "open dashboard",
      },
    ],
    marketingBrief: {
      mode: "sample",
      headline:
        "Public sample: ipop has shipped product work, but customer acquisition is still blocked until auth, connectors, and live outbound proof are real.",
      executiveSummary: [
        { label: "work shipped today", value: "3", detail: "public product fixes, not customer outcomes", tone: "warn", proof: "PR #1276, PR #1277, dashboard receipt" },
        { label: "pipeline moved", value: "0", detail: "no external leads qualified or contacted", tone: "bad", proof: "zero prospect/customer receipts" },
        { label: "approvals waiting", value: "2", detail: "owner must choose first channel and success bar", tone: "warn", proof: "public CMO brief decisions" },
        { label: "blocked channels", value: "3", detail: "iMessage, outbound, connectors need live proof", tone: "bad", proof: "GitHub #1283/#1285/#1286" },
      ],
      sinceLastCheckIn: [
        { title: "Homepage serves the simplified marketing-door flow", owner: "Scout", proof: "production / route receipt" },
        { title: "Dashboard labels proof classes instead of implying fake traction", owner: "Lens", proof: "public CMO brief" },
        { title: "External customer proof remains zero", owner: "Operator", proof: "zero signup/payment/customer approval receipts" },
      ],
      goal: {
        label: "30-day customer goal",
        target: "10 activated trial teams",
        current: "0 converted",
        pace: "behind until sign-in and one real channel work",
        confidence: "low",
      },
      metrics: [
        { label: "leads found", value: "0", detail: "no live prospect source connected", tone: "bad", proofKind: "live", proof: "public dashboard has no prospect source receipt" },
        { label: "qualified", value: "0", detail: "no ICP scoring receipt", tone: "bad", proofKind: "live", proof: "public dashboard has no ICP scoring receipt" },
        { label: "contacted", value: "0", detail: "outbound path still gated", tone: "bad", proofKind: "live", proof: "public dashboard has no sent-message receipt" },
        { label: "replies", value: "0", detail: "no external conversations yet", tone: "bad", proofKind: "external", proof: "zero reply/customer receipts" },
        { label: "customers", value: "0", detail: "dogfood only so far", tone: "bad", proofKind: "external", proof: "zero signup/payment/customer approval receipts" },
        { label: "spend / roi", value: "$0 / —", detail: "no paid acquisition running", tone: "neutral", proofKind: "live", proof: "no paid campaign spend receipt" },
      ],
      capacity: [
        { label: "active campaign lanes", value: "0 / 1", detail: "first live acquisition lane not proven", tone: "bad", proof: "no contacted-lead receipt" },
        { label: "agent seats used", value: "4 / 3", detail: "sample shows team shape; plan must enforce seats live", tone: "warn", proof: "sample room has Scout/Quill/Echo/Bid" },
        { label: "monthly work cap", value: "$0 / $200", detail: "do not upsell until the first lane creates value", tone: "neutral", proof: "no spend/revenue receipt" },
      ],
      funnel: [
        { label: "market read", count: "1", detail: "Tomo/reload.chat dogfood brief converted into product work", tone: "warn" },
        { label: "ICP ranked", count: "0", detail: "no live prospect scoring receipt yet", tone: "bad" },
        { label: "messages drafted", count: "0", detail: "agents need source data before writing", tone: "bad" },
        { label: "sent", count: "0", detail: "outbound still dry-run/approval gated", tone: "bad" },
        { label: "won", count: "0", detail: "no external customer proof", tone: "bad" },
      ],
      channels: [
        {
          source: "homepage",
          status: "live but not yet converting",
          pipeline: "0 customers",
          conversion: "unproven",
          spend: "$0",
          next: "instrument starts, signups, and activation",
        },
        {
          source: "iMessage room",
          status: "preview only",
          pipeline: "0 usable conversations",
          conversion: "blocked",
          spend: "$0",
          next: "ship real inbound/outbound relay",
        },
        {
          source: "outbound",
          status: "mock/dry-run risk",
          pipeline: "0 contacted leads",
          conversion: "blocked",
          spend: "$0",
          next: "connect one real channel and prove one sent receipt",
        },
      ],
      blockers: [
        { title: "Signed-in team-engine runtime proof", owner: "Operator", proof: "GitHub #1282" },
        { title: "iMessage is not a real group room yet", owner: "Echo", proof: "GitHub #1283" },
        { title: "Connectors can look green without provider proof", owner: "Scout", proof: "GitHub #1284" },
      ],
      decisions: [
        { title: "Pick the first real acquisition channel to prove", owner: "You", proof: "iMessage, Gmail, or one outreach provider" },
        { title: "Approve one measurable success bar", owner: "You", proof: "e.g. 10 activated trial teams in 30 days" },
      ],
      nextActions: [
        { title: "Make dashboard live-data backed", owner: "Lens", proof: "GitHub #1287" },
        { title: "Enable one real OAuth/provider path", owner: "Scout", proof: "GitHub #1285" },
        { title: "Replace mock reach with one real prospect flow", owner: "Echo", proof: "GitHub #1286" },
      ],
      readiness: [
        { label: "auth", status: "blocked", proof: "Google sign-in and signed-in team runtime remain the gate" },
        { label: "connectors", status: "blocked", proof: "OAuth/provider paths still need real receipts" },
        { label: "first run", status: "pending", proof: "site-read flow exists; server-backed team activation is still pending merge" },
        { label: "outbound", status: "blocked", proof: "real send path is not proven" },
        { label: "billing", status: "pending", proof: "pricing is visible; plan enforcement needs live subscription receipts" },
        { label: "observability", status: "pending", proof: "agent health/audit trail not surfaced here yet" },
        { label: "legal/trust", status: "ready", proof: "terms/privacy/company links are visible; customer-proof claims stay zero" },
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
