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
  readonly group: "productivity" | "marketing" | "publishing";
  readonly name: string;
  readonly status: "connected" | "available" | "coming_soon";
  readonly detail: string;
  readonly href: string;
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
        role: "ICP + SEO",
        status: "working",
        task: "Crawling the site and sketching the first customer hypothesis.",
      },
      {
        id: "quill",
        agent: "Quill",
        role: "Copy",
        status: "done",
        task: "Drafted the homepage hero rewrite and launch-thread angle.",
      },
      {
        id: "echo",
        agent: "Echo",
        role: "Outreach",
        status: "blocked",
        task: "Found warm threads; waiting for send approval before anything leaves.",
      },
      {
        id: "lens",
        agent: "Lens",
        role: "Brand",
        status: "working",
        task: "Checking the tone against receipts-over-adjectives.",
      },
      {
        id: "codex",
        agent: "Codex",
        role: "Operator",
        status: "codex",
        task: "Ready for product/code work when the room needs this subscription.",
      },
    ],
    connectors: [
      {
        id: "gmail",
        group: "productivity",
        name: "Gmail",
        status: "connected",
        detail: "gagan@getfoolish.com",
        href: "/settings?section=connections&connector=gmail",
      },
      {
        id: "calendar",
        group: "productivity",
        name: "Google Calendar",
        status: "available",
        detail: "let the room see launch dates and follow-ups.",
        href: "/settings?section=connections&connector=google-calendar",
      },
      {
        id: "drive",
        group: "productivity",
        name: "Google Drive",
        status: "available",
        detail: "brand docs, case studies, and proof in one place.",
        href: "/settings?section=connections&connector=google-drive",
      },
      {
        id: "linkedin",
        group: "marketing",
        name: "LinkedIn",
        status: "available",
        detail: "company research and human-approved outbound.",
        href: "/settings?section=connections&connector=linkedin",
      },
      {
        id: "site-publishing",
        group: "publishing",
        name: "Site publishing",
        status: "available",
        detail: "publish approved pages instead of stopping at previews.",
        href: "/settings?section=connections&connector=site-publishing",
      },
    ],
    thread: [
      {
        id: "t1",
        kind: "agent-line",
        agent: "Scout",
        at: "9:02 am",
        text: "had a poke around your site overnight. your pricing page buries the one thing people actually want — the free trial. i've got thoughts.",
      },
      {
        id: "t2",
        kind: "deliverable",
        agent: "Quill",
        at: "9:14 am",
        deliverable: {
          title: "rewritten homepage hero",
          kind: "diff",
          before: "The all-in-one platform for modern teams.",
          preview: "Ship faster. Your whole marketing department, minus the meetings.",
        },
      },
      {
        id: "t3",
        kind: "agent-line",
        agent: "Echo",
        at: "11:30 am",
        text: "found 3 reddit threads where people are basically begging for what you sell. drafted replies that help first and mention you second. ready when you are.",
      },
      {
        id: "t4",
        kind: "deliverable",
        agent: "Echo",
        at: "11:31 am",
        deliverable: {
          title: "draft reply to r/marketing",
          kind: "draft",
          preview:
            "honestly the thing that worked for us was treating outreach as research, not pitching. we used ipop to draft the first pass and a human approved every send — kept it human, scaled the boring bit.",
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
      agent: "Codex",
      role: "Operator",
      status: "codex",
      task: "Available for product/code handoffs through this Codex subscription.",
    },
  ];
}

export function defaultConnectors(): readonly EverydayConnector[] {
  return [
    {
      id: "gmail",
      group: "productivity",
      name: "Gmail",
      status: "available",
      detail: "email, replies, and follow-up receipts.",
      href: "/settings?section=connections&connector=gmail",
    },
    {
      id: "calendar",
      group: "productivity",
      name: "Google Calendar",
      status: "available",
      detail: "meetings, launch dates, and reminders.",
      href: "/settings?section=connections&connector=google-calendar",
    },
    {
      id: "drive",
      group: "productivity",
      name: "Google Drive",
      status: "available",
      detail: "docs, screenshots, and brand proof.",
      href: "/settings?section=connections&connector=google-drive",
    },
    {
      id: "linkedin",
      group: "marketing",
      name: "LinkedIn",
      status: "available",
      detail: "prospects and company research, with send approval.",
      href: "/settings?section=connections&connector=linkedin",
    },
    {
      id: "site-publishing",
      group: "publishing",
      name: "Site publishing",
      status: "available",
      detail: "approved pages can go live, not just to preview.",
      href: "/settings?section=connections&connector=site-publishing",
    },
  ];
}
