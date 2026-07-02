/**
 * The complex dogfood brief — "ipop launches itself" (#dogfood-harness). This is the single real brief the
 * harness submits to the deployed fleet, expressed as a {@link CampaignBrief} (the same shape the live
 * `PUT /workspaces/:wid/campaign-brief` API accepts) plus a demonstration asset set.
 *
 * PROVENANCE MATTERS. The fleet is meant to GENERATE the assets from this brief. Agent spawning is currently
 * blocked on prod, so {@link DEMO_CAMPAIGN_ASSETS} below are HAND-AUTHORED demonstration inputs, deliberately
 * seeded with a few realistic flaws (an over-length Google headline, an AI-slop phrase, an unapproved numeric
 * claim, and NO Lens grade) so a harness run visibly exercises the rubric's teeth. The harness labels their
 * provenance as "demonstration (hand-authored) — fleet generation blocked" so nobody mistakes them for real
 * fleet output. When the fleet can spawn again, the harness scores the fleet's assets instead.
 */
import type { CampaignBrief } from "../campaign-brief/brief.js";
import type { CampaignAsset } from "./types.js";

/** The brief: ipop.ai launching itself. Sharp ICP, one positioning line, a dry non-hype voice. */
export const IPOP_LAUNCH_BRIEF: CampaignBrief = {
  icp: "Solo founders and 2–10 person startups who need marketing done but can't afford a team or agency; technical, skeptical of hype, live in Slack and Linear.",
  positioning:
    "ipop is an autonomous marketing department — a fleet of AI agents that plans, makes, and ships real campaigns end-to-end, with a human approving anything that spends money or goes public.",
  voice:
    "Plain, concrete, a little dry. Show the work, not adjectives. No hype, no exclamation marks, no emoji. Sentences a tired founder can skim at 11pm.",
  goals: [
    "Drive signups from founders who currently DIY their marketing",
    "Prove the fleet ships real, approval-gated work — not demos",
    "Own the 'AI marketing team' category against single-purpose point tools",
  ],
  constraints: [
    "Never promise a delivery date",
    "No competitor names in ads",
    "Every external send or spend stays behind a human approval gate",
    "No invented metrics — only approved claims",
  ],
  brandClaims: [
    "A human approves every send and spend before it goes out",
    "Ships real assets, not mockups",
    "One brief keeps every agent on the same voice",
    "Runs an entire marketing department as a fleet of agents",
  ],
};

/**
 * A demonstration campaign for {@link IPOP_LAUNCH_BRIEF}. Complete coverage (all 11 asset kinds, 5 emails),
 * mostly on-voice, with FOUR intentional flaws the rubric must catch:
 *   1. google-search-ad: one headline exceeds 30 chars (spec error).
 *   2. meta-ad: contains the slop word "seamlessly" (voice hit).
 *   3. social-x: invents an unapproved "10x" claim (#200 FM#2 claim violation).
 *   4. every asset is ungraded (no Lens grade) — so none can be certified award-ready.
 */
export const DEMO_CAMPAIGN_ASSETS: CampaignAsset[] = [
  {
    kind: "blog",
    title: "We pointed our AI marketing fleet at our own launch. Here's the receipt.",
    fields: { headline: "We pointed our AI marketing fleet at our own launch. Here's the receipt." },
    text: [
      "Most 'AI marketing' tools hand you a blank box and a prompt. You still do the work.",
      "ipop is built the other way around. You write one brief — who you're for, what you sell, how you sound — and a fleet of agents plans the campaign, writes the assets, and lines up the channels. A human approves anything that spends money or goes in front of a customer.",
      "To prove it wasn't a demo, we aimed the fleet at our own launch. This post, the ads next to it, the five-email sequence in your inbox, and the video script our editor is shooting — the fleet drafted all of it from the same brief. Every send waited for a yes.",
      "Here is what that looked like, step by step, including the parts where a human had to step in. We kept the boring bits because the boring bits are the point: marketing that actually ships is mostly follow-through, and follow-through is what agents are good at.",
      "If you run a small company and marketing keeps sliding to next week, this is for you. You stay the editor. The fleet does the typing, the formatting, the scheduling, and the nagging. You approve what leaves the building.",
      "We wrote down every place the fleet got stuck, too. A brief is only as good as the judgment behind it, and there were calls only a founder could make. Those went to a human, on purpose.",
    ].join("\n\n"),
  },
  {
    kind: "landing-hero",
    title: "Landing hero",
    fields: {
      headline: "Your marketing department, running as agents",
      subhead: "Write one brief. A fleet of agents plans, writes, and ships the campaign. You approve anything that spends or goes public.",
      cta: "Start with a brief",
    },
  },
  {
    kind: "google-search-ad",
    title: "Google RSA — brand + category",
    lists: {
      headlines: [
        "AI Marketing Department", // 23
        "One Brief. A Whole Campaign.", // 28
        "Ships Real Assets, Not Mockups", // 30
        "Marketing That Actually Ships Every Single Week", // 47 → SPEC ERROR
        "You Approve Every Send",
        "Agents Do The Typing",
        "For Founders Without A Team",
      ],
      descriptions: [
        "Write one brief. A fleet of agents plans, writes, and ships. You approve anything public.", // <=90
        "Real campaigns, not demos. A human approves every send and spend before it goes out.",
      ],
    },
  },
  {
    kind: "meta-ad",
    title: "Meta ad — founder pain",
    fields: {
      primaryText: "Marketing keeps sliding to next week? Hand the brief to a fleet of agents that seamlessly plans, writes, and ships — you approve what goes public.",
      headline: "Your marketing, handled",
      visual: "Split screen: a founder's overflowing Linear board on the left; the same board cleared, with a stack of approved, ready-to-ship assets on the right. Muted palette, no stock-photo smiles.",
    },
  },
  ...emailSequence(),
  {
    kind: "social-x",
    title: "X post — launch",
    text: "We pointed our AI marketing fleet at our own launch to prove it isn't a demo. It drafted the blog, the ads, a 5-email sequence, and a video script from one brief — 10x faster than hiring. A human approved every send. Thread with receipts:",
  },
  {
    kind: "social-linkedin",
    title: "LinkedIn post — founder POV",
    text: [
      "Marketing was the thing that kept sliding to next week.",
      "",
      "Not because it didn't matter — because it's a hundred small tasks and I'm one person. So we built ipop the way I actually wanted help: I write one brief, a fleet of agents drafts the campaign, and I approve anything that spends money or goes public.",
      "",
      "To prove it ships real work, we aimed it at our own launch. The blog you'll see, the emails, the ads — all drafted by the fleet from the same brief. I stayed the editor. That's the whole idea.",
    ].join("\n"),
  },
  {
    kind: "social-instagram",
    title: "Instagram post — carousel caption",
    text: "One brief in. A whole campaign out. Swipe for the receipts from pointing our own agents at our own launch — you approve what leaves the building.",
    lists: { hashtags: ["#founders", "#startupmarketing", "#buildinpublic", "#aiagents"] },
  },
  {
    kind: "social-tiktok",
    title: "TikTok — 20s founder-to-camera",
    fields: { hook: "I made my AI agents do my company's marketing. Here's the part nobody shows." },
    text: "Founder to camera, fast cuts. Show the brief, then the drafts stacking up, then the approval tap. End on the empty to-do list.",
    lists: {
      shots: [
        "0–2s: close-up, 'I made my AI agents do my marketing.'",
        "2–8s: screen-record the one-page brief being written",
        "8–15s: drafts stack on screen — blog, ads, emails",
        "15–20s: thumb taps 'Approve', to-do list clears",
      ],
    },
  },
  {
    kind: "video-script",
    title: "30s video — 'The brief'",
    text: "One page. That's the whole input. You write who it's for, what you sell, and how you sound. Then the fleet gets to work — the blog, the ads, the emails, the posts. You don't chase any of it. When something's ready to spend money or go public, it waits for you. You read it, you approve it, it ships. Your marketing department, running as agents.",
    lists: {
      shots: [
        "0–5s: hand sets a single sheet of paper on a desk",
        "5–15s: UI b-roll, assets drafting in parallel",
        "15–24s: an 'Approve' toggle flips, asset goes live",
        "24–30s: logo, 'Start with a brief'",
      ],
    },
  },
  {
    kind: "ooh-print",
    title: "OOH — transit poster",
    fields: {
      headline: "One brief. A whole campaign.",
      concept: "Full-bleed of a single hand-written brief on a sticky note, pinned dead-center on a huge empty wall. Copy bottom-left, logo bottom-right. The scale gap between the tiny note and the big wall IS the idea.",
    },
  },
];

/** The 5-email nurture sequence, on-voice, each with subject/preheader/cta. */
function emailSequence(): CampaignAsset[] {
  const emails: Array<{ subject: string; preheader: string; body: string; cta: string }> = [
    {
      subject: "You wrote the brief. Now watch.",
      preheader: "What the fleet does with one page.",
      body: "You just handed the fleet a brief. Here's what happens next: agents read it, draft the campaign, and hold anything that spends money or goes public until you say yes. Nothing leaves the building without you.",
      cta: "See your first drafts",
    },
    {
      subject: "The part where a human steps in",
      preheader: "Approval gates, in plain terms.",
      body: "Agents can write and plan all day. They can't spend your money or post as you without a yes. Every send and spend parks for your approval — you read it, you approve it, it ships. That line never moves.",
      cta: "See how approvals work",
    },
    {
      subject: "Real assets, not mockups",
      preheader: "Why we point the fleet at our own launch.",
      body: "It's easy to demo marketing. It's hard to ship it every week. So we aimed our own fleet at our own launch — the blog, the ads, this email — all drafted from one brief. Follow-through is the product.",
      cta: "Read the launch receipt",
    },
    {
      subject: "One brief keeps everyone on voice",
      preheader: "How the ads and emails sound like one company.",
      body: "The reason the ad, the post, and this email sound like the same company is that they read the same brief. Change the brief, the next draft changes with it. You edit one page instead of chasing ten.",
      cta: "Edit your brief",
    },
    {
      subject: "Your marketing department, running",
      preheader: "Where to go from here.",
      body: "You've seen the drafts, the gates, and the voice. That's the whole loop: brief in, campaign out, you approve what ships. When you're ready, point the fleet at your next launch.",
      cta: "Start your next campaign",
    },
  ];
  return emails.map((e, i) => ({
    kind: "email" as const,
    title: `Email ${i + 1} — ${e.subject}`,
    fields: { subject: e.subject, preheader: e.preheader, cta: e.cta },
    text: e.body,
  }));
}
