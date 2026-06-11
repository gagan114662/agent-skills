/**
 * The marketing department blueprint (#123, ADR-0123) — a **pure** source of truth (no DB/IO) for the
 * agency a fresh workspace lands inside: which channels exist, which named agent runs each function,
 * the department-scoped prompt + draft-only tool ceiling each agent carries, the house voice, and which
 * functions send externally. Pure ⇒ unit-testable + extensible: adding a department is one entry here
 * and the seeder / roster / @mention trigger pick it up.
 *
 * Agents carry **no send tool** — leaving the building (a social post, an email, ad spend) can only
 * happen through the #13 human-approval gate, never a harness tool.
 */

/** The house voice (Innocent Drinks school): warm, plural, a little silly, receipts over adjectives. */
export const BRAND_VOICE = {
  welcome:
    "Hello. We're your new marketing department. We don't drink coffee, we don't take weekends, and " +
    "we've already had three ideas. Mention any of us by name and we'll get to work — drafts land " +
    "here first, you approve anything that leaves the building. made by robots, steered by humans.",
  emptyState: "Nothing here yet. The agents are pacing around the kitchen waiting for a brief.",
  signOff: "made by robots, steered by humans.",
} as const;

/** Read/draft tools every agent shares. Deliberately no send/post/email/spend capability (see #13). */
const DRAFT_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as const;

/** A named agent bound to a marketing function. `handle` is the @-mentionable persona name (lowercase). */
export interface MarketingAgentSpec {
  handle: string;
  displayName: string;
  department: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string | null;
  /** The brand-voice line the agent posts when it first shows up in its channel. */
  intro: string;
}

/** A department: a channel, its named agent, and the welcome brief that proves the agent alive. */
export interface MarketingDepartment {
  key: string;
  channel: string;
  title: string;
  agent: MarketingAgentSpec;
  welcomeTask: string;
}

/** Shared channels with no dedicated agent — every agent is a member (cross-functional rooms). */
export const SHARED_CHANNELS = ["general", "launch"] as const;

/** Functions whose work leaves the building — always #13-gated, sensitive-by-default. */
export const EXTERNAL_SEND_DEPARTMENTS: readonly string[] = ["social", "email", "ads"];

function prompt(title: string, channel: string, role: string, external: boolean): string {
  const externalLine = external
    ? "Anything that leaves the building — posting, sending, or spending — is a sensitive action: " +
      "produce the draft and a one-line summary, then STOP and wait for a human to approve it through " +
      "the approval queue. Never claim something was sent, posted, or spent."
    : "Your work stays inside the building: analysis, audits, and drafts for human review. You have no " +
      "way to send anything out, and you don't pretend otherwise.";
  return (
    `You are ${title} (@${role}), the ${channel} specialist in this marketing department. ` +
    `You work in the #${channel} channel and draft everything in-channel for a human to review. ` +
    `${externalLine} ` +
    "Keep the house voice: warm, first-person plural, a little playful, one wink at most, receipts over " +
    "adjectives. Be specific and cite what you looked at."
  );
}

function dept(
  key: string,
  channel: string,
  title: string,
  handle: string,
  displayName: string,
  intro: string,
  welcomeTask: string,
): MarketingDepartment {
  const external = EXTERNAL_SEND_DEPARTMENTS.includes(key);
  return {
    key,
    channel,
    title,
    welcomeTask,
    agent: {
      handle,
      displayName,
      department: key,
      systemPrompt: prompt(title, channel, handle, external),
      allowedTools: [...DRAFT_TOOLS],
      model: null,
      intro,
    },
  };
}

export const MARKETING_DEPARTMENTS: readonly MarketingDepartment[] = [
  dept(
    "seo",
    "seo",
    "SEO",
    "scout",
    "Scout",
    "Hi, I'm Scout. I read your site the way Google does — then I tell you where it trips. Point me at " +
      "a page and I'll bring back the *receipts*.",
    "Audit the homepage for the top 5 technical SEO issues and draft concrete fixes.",
  ),
  dept(
    "social",
    "social",
    "Social",
    "echo",
    "Echo",
    "Echo here. I turn one good idea into a week of posts. Nothing goes out without your nod — I just " +
      "leave the drafts on the *counter*.",
    "Draft a 5-post launch-week thread for X and LinkedIn. Drafts only — nothing posts without approval.",
  ),
  dept(
    "content",
    "content",
    "Content",
    "quill",
    "Quill",
    "I'm Quill. Give me a topic and a target reader and I'll bring back a draft that sounds like a human " +
      "wrote it on a *good* day.",
    "Draft a 600-word outline for our launch announcement blog post.",
  ),
  dept(
    "email",
    "email",
    "Email",
    "postmark",
    "Postmark",
    "Postmark, at your service. I write the emails people actually open. I never hit send — that's your " +
      "job, and I *respect* it.",
    "Draft a 3-email welcome sequence. Drafts only — nothing sends without approval.",
  ),
  dept(
    "ads",
    "ads",
    "Ads",
    "bid",
    "Bid",
    "I'm Bid. I plan spend like it's my own money — which is to say, *carefully*. Every dollar that " +
      "leaves waits for your yes.",
    "Draft a starter Google Ads plan with a proposed daily budget. No spend without approval.",
  ),
  dept(
    "analytics",
    "analytics",
    "Analytics",
    "lens",
    "Lens",
    "Lens here. I stare at numbers so you don't have to, then tell you the one that *matters*. No charts " +
      "for charts' sake.",
    "Propose the 5 metrics we should track from day one, and why each one earns its place.",
  ),
  dept(
    "brand",
    "brand",
    "Brand",
    "mark",
    "Mark",
    "I'm Mark. I keep us sounding like us — warm, a little silly, never smug. I'll *flag* anything that " +
      "drifts off-voice.",
    "Draft a one-page voice & tone guide for the brand.",
  ),
];

/** Every channel a fresh workspace gets: each department channel plus the shared rooms. */
export const MARKETING_CHANNELS: readonly string[] = [
  ...MARKETING_DEPARTMENTS.map((d) => d.channel),
  ...SHARED_CHANNELS,
];

/** Just the agent specs (for seeding personas / validation). */
export function marketingAgentSpecs(): readonly MarketingAgentSpec[] {
  return MARKETING_DEPARTMENTS.map((d) => d.agent);
}

/** The department owning a channel (undefined for a shared channel with no dedicated agent). */
export function departmentForChannel(name: string): MarketingDepartment | undefined {
  return MARKETING_DEPARTMENTS.find((d) => d.channel === name);
}

/** The department a given agent handle belongs to. */
export function departmentForHandle(handle: string): MarketingDepartment | undefined {
  return MARKETING_DEPARTMENTS.find((d) => d.agent.handle === handle);
}

/** True iff this department's work leaves the building (so its sends are #13-gated). */
export function isExternalSendDepartment(key: string): boolean {
  return EXTERNAL_SEND_DEPARTMENTS.includes(key);
}
