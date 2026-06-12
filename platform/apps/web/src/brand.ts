/**
 * Brand identity for the web console, resolved at build time from VITE_BRAND_* env vars.
 *
 * The defaults describe **ipop** — the deployed product brand at ipop.ai. "Reload" is the internal
 * platform/codebase name and must never appear in product chrome. Components import these values
 * instead of hardcoding brand strings; `brand.test.ts` enforces the no-hardcoded-strings rule.
 *
 * To rebrand a deployment, set the env vars at build time (e.g. on the Vercel project):
 *   VITE_BRAND_NAME    — product name in the header, auth card, and sidebar
 *   VITE_BRAND_MARK    — single-glyph logo mark rendered beside the name
 *   VITE_BRAND_TITLE   — full document <title>
 *   VITE_BRAND_TAGLINE — one-line tagline on the login card
 *   VITE_BRAND_ACCENT  — accent color (any CSS color), applied as the `--accent` custom property
 */
const env = import.meta.env;

export interface Brand {
  /** Product name shown in headers, the auth card, and the sidebar. */
  readonly name: string;
  /** Single-glyph logo mark rendered beside the name. */
  readonly mark: string;
  /** Full document <title>. */
  readonly title: string;
  /** One-line tagline on the login card. */
  readonly tagline: string;
  /** Accent color (any CSS color), applied as the `--accent` custom property. */
  readonly accent: string;
}

export const BRAND: Brand = {
  name: env.VITE_BRAND_NAME ?? "ipop",
  // The Pop Mark: a single vermilion dot — the popped i-dot, standing alone (splash + favicon).
  mark: env.VITE_BRAND_MARK ?? "●",
  title: env.VITE_BRAND_TITLE ?? "ipop — your marketing agency of AI agents",
  tagline: env.VITE_BRAND_TAGLINE ?? "The marketing agency of AI agents — you steer, they ship.",
  // Pop Vermilion — the one loud colour. See docs/brand/ipop-brand-identity.html.
  accent: env.VITE_BRAND_ACCENT ?? "#ff4524",
};

/**
 * The house voice (Innocent Drinks school): warm, first-person plural, a little silly, receipts over
 * adjectives. Empty states and errors are moments, not dead ends. The server fleet (#123) carries the
 * same voice in `marketing/blueprint.ts`; this is the web console's copy. Centralised here so the
 * chrome components stay free of hardcoded brand strings (see brand.test.ts). Sign-off everywhere:
 * "made by robots, steered by humans." See docs/brand/ipop-brand-identity.html.
 */
export const VOICE = {
  signOff: "made by robots, steered by humans.",
  loading: "Waking up the department…",
  /** Shown when no channel is selected. */
  emptyChannel: "Nothing here yet. The agents are pacing around the kitchen waiting for a brief.",
  /** Shown when a channel has no messages. */
  noMessages: "Quiet in here. Say hello 👋 — they don't bite (they can't, they're software).",
  /** Shown when the API can't be reached (#108 offline state). */
  offlineTitle: "Can't reach the back office",
  offlineBody:
    "We loaded fine, but we can't reach the API server yet. The agents are outside knocking — give it " +
    "a second and try again.",
  /** Empty mentions inbox. */
  noMentions: "No mentions yet. Tag an agent by name and they'll get to work.",
  /** Shown above the sign-in card when auth fails. The voice turns a dead end into a moment (#145). */
  authError: "Well, that didn't pop. Give it another go —",
  /** Empty approvals queue (per status reads naturally: "Nothing pending. …"). */
  emptyApprovals: "All clear here. The agents will ping you the moment something needs a human.",
  /** No agent sessions in a channel (Deploy / Review / Run rails). */
  noSessions: "No agent sessions here yet. Kick one off and it'll show up on this rail.",
  /** Deploy rail: a session is picked but nothing deployed. */
  pickSessionToDeploy: "Pick a session on the left and we'll ship its app to a live URL.",
  /** Founder console: nothing waiting. */
  noPendingApprovals: "Nothing waiting on you. Go get a coffee — we've got this.",

  // --- Composer + automations interactions (#167) -------------------------------------------------
  /** Automations form: no name yet. */
  automationNeedsName: "Give it a name first — something like “Monday SEO audit”.",
  /** Automations form: no channel picked. */
  automationNeedsChannel: "Pick a channel so we know which department runs it.",
  /** Automations form: no template picked. */
  automationNeedsTemplate: "Choose a task template — that's the brief the agent runs.",
  /** Automations create failed server-side; the server's reason is appended after this. */
  automationCreateFailed: "That didn't pop —",
  /** Automations created OK (brand-voice confirmation). */
  automationCreated: "Done. It's on the books and ready to run.",
  /** Composer: send blocked because the message still has unfilled {{placeholders}}. */
  unresolvedPlaceholders: "Fill in the blanks first — there's still a {{…}} waiting on you.",
  /** Template picker: prompt above the per-variable fields. */
  templateFillPrompt: "Fill these in and we'll drop the brief in for you.",
  /** Template picker: the insert button. */
  templateInsert: "Insert brief",
  /** Composer: a message was steered (#54 jump-ahead). */
  steerSent: "Steer sent — we pushed that to the front of the line.",
  /** Composer: a message was queued (sends in turn). */
  queued: "Queued — it'll send in turn.",
} as const;

/**
 * The department spectrum (#123 fleet × #138 pop identity): one hue per marketing function, a
 * warm→cool arc anchored on Pop Vermilion. Keyed by the preloaded channel name so each department
 * channel and its named agent can wear its colour. See docs/brand/ipop-brand-identity.html.
 */
export const DEPARTMENT_SPECTRUM: Readonly<Record<string, string>> = {
  seo: "#ff4524", // Scout
  social: "#ff7a00", // Echo
  content: "#f0b429", // Quill
  email: "#2fb170", // Postmark
  ads: "#1fa2c4", // Bid (the "Paid" department)
  analytics: "#5b6cff", // Lens
  brand: "#b07bff", // Mark
};

/** The spectrum colour for a channel name, or undefined if it isn't a department channel. */
export function departmentColor(channelName: string | null | undefined): string | undefined {
  return channelName ? DEPARTMENT_SPECTRUM[channelName] : undefined;
}

/**
 * The named fleet (#123 marketing department × #138 pop identity) as the public site presents it.
 * One entry per marketing function: the @-mentionable handle, display name, the department key that
 * keys its spectrum colour, and a one-line personality in the house voice. Mirrors the server blueprint
 * (`marketing/blueprint.ts`) — kept here (not imported) because the web app can't reach server code, and
 * centralised so the landing page carries no hardcoded brand copy (enforced by brand.test.ts).
 */
export interface FleetAgent {
  /** Lowercase @-mention handle. */
  readonly handle: string;
  /** Display name shown on the card. */
  readonly name: string;
  /** Marketing function — keys {@link DEPARTMENT_SPECTRUM} for the agent's hue. */
  readonly department: keyof typeof DEPARTMENT_SPECTRUM;
  /** One warm, crisp line of personality (house voice). */
  readonly personality: string;
}

export const FLEET: readonly FleetAgent[] = [
  { handle: "scout", name: "Scout", department: "seo", personality: "Reads your site the way Google does — then tells you exactly where it trips." },
  { handle: "echo", name: "Echo", department: "social", personality: "Turns one good idea into a week of posts. Nothing leaves without your nod." },
  { handle: "quill", name: "Quill", department: "content", personality: "Writes like a human on a good day — drafts that sound like you, faster." },
  { handle: "postmark", name: "Postmark", department: "email", personality: "Writes the emails people actually open. Never hits send — that's your call." },
  { handle: "bid", name: "Bid", department: "ads", personality: "Plans spend like it's their own money — which is to say, carefully." },
  { handle: "lens", name: "Lens", department: "analytics", personality: "Stares at the numbers so you don't have to, then names the one that matters." },
  { handle: "mark", name: "Mark", department: "brand", personality: "Keeps us sounding like us — warm, a little silly, never smug." },
];

/**
 * A single line in the hero's staged chat vignette (#149) — a scripted, looping peek at the fleet at
 * work. `from` is `"you"` (the human steering) or a fleet handle; `dept` keys the bubble's colour; the
 * optional `done` flag marks the line that fires the confetti pop. Pure data so the animation component
 * stays presentational and the copy stays in one place.
 */
export interface VignetteLine {
  readonly from: "you" | (string & {});
  readonly dept?: keyof typeof DEPARTMENT_SPECTRUM;
  readonly text: string;
  readonly done?: boolean;
}

/** The three plans, teaser-sized, mirroring the server catalog (`billing/plans.ts`, #125). */
export interface PlanTeaser {
  readonly name: string;
  readonly price: string;
  readonly tagline: string;
  readonly featured: boolean;
}

/**
 * All copy for the public landing page (#149), in the house voice. Centralised here so the page reads
 * the brand instead of inlining strings (brand.test.ts scans the landing components for the rule).
 */
export const LANDING = {
  /** Hero. The headline reuses {@link Brand.tagline} so the one promise lives in exactly one place. */
  hero: {
    eyebrow: "Your always-on marketing department",
    sub:
      "Hire a whole marketing department of AI agents. They draft, research, and plan around the clock — " +
      "you approve anything that leaves the building.",
    ctaPrimary: "Start free",
    ctaSecondary: "Sign in",
  },
  /** The looping hero vignette — a tiny staged channel where the fleet visibly does work. */
  vignette: [
    { from: "you", text: "@scout how's our homepage doing for SEO?" },
    { from: "scout", dept: "seo", text: "On it — reading the page the way Google does…" },
    { from: "scout", dept: "seo", text: "Found 5 issues. Biggest: /pricing has no meta description. Draft fix ready 👇" },
    { from: "quill", dept: "content", text: "I'll write a 60-char description that actually sounds like us." },
    { from: "echo", dept: "social", text: "And I'll turn the fix into a week of launch posts — drafts only, promise." },
    { from: "you", text: "love it. ship the SEO fix." },
    { from: "scout", dept: "seo", text: "Fix drafted and queued for your approval. 🎉", done: true },
  ] as readonly VignetteLine[],
  /** How it works — three steps with playful on-scroll motion. */
  steps: [
    { n: "01", title: "Brief them", body: "Mention an agent by name and tell them what you need — like Slacking a teammate." },
    { n: "02", title: "They get to work", body: "Real agents research, draft, and plan in the channel. You watch it happen, live." },
    { n: "03", title: "You approve", body: "Nothing leaves the building without your yes. Drafts land first; you ship the good ones." },
  ],
  sections: {
    howTitle: "How it works",
    howSub: "Three steps. No onboarding call, no Gantt chart.",
    fleetTitle: "Meet the department",
    fleetSub: "Seven specialists, one channel each, all on the same team.",
    pricingTitle: "Pick your pop",
    pricingSub: "Start small, grow when you feel like it.",
    pricingCta: "See all plans",
    ctaTitle: "Your new marketing team is waiting.",
    ctaSub: "We don't drink coffee, we don't take weekends, and we've already had three ideas.",
    ctaButton: "Hire the fleet",
  },
  /** Mirrors `billing/plans.ts` (#125): Starter → Pro → Agency, ascending price. */
  plans: [
    { name: "Starter", price: "$49", tagline: "Your first three agents.", featured: false },
    { name: "Pro", price: "$199", tagline: "A team that never sleeps.", featured: true },
    { name: "Agency", price: "$499", tagline: "A whole building of agents.", featured: false },
  ] as readonly PlanTeaser[],
} as const;

/**
 * Trust page copy (#151). DELIBERATELY HONEST: `guarantees` lists only mechanisms that are actually
 * built and enforced in code today; `roadmap` lists things that are NOT yet built or certified, each
 * flagged with a status so the page can never read as a claim. `notClaimed` states plainly that we hold
 * no third-party certifications. A test (`brand.test.ts`) enforces that every roadmap item is
 * status-flagged and that no certification is asserted as current.
 */
export const SECURITY = {
  eyebrow: "Trust, stated plainly",
  title: "What actually protects your work",
  sub:
    "No badges we didn't earn. Here is exactly what the platform enforces today — and, just as plainly, " +
    "what we haven't built yet.",
  /** Real, shipped, code-enforced guarantees. Each maps to a mechanism that exists in the product. */
  guarantees: [
    {
      title: "Human approval gates",
      body: "Anything that leaves the building — an outbound send, a refund — pauses for a human to approve or reject. Agents draft; people decide.",
    },
    {
      title: "Tenant isolation",
      body: "Every request is scoped to your workspace. One tenant can never read or touch another's data, sessions, or secrets.",
    },
    {
      title: "Kill switch",
      body: "One switch halts all autonomous launches for a workspace immediately — no in-flight work can start once it's flipped.",
    },
    {
      title: "Budget caps",
      body: "Per-tenant spend and concurrency ceilings stop a runaway fleet before it bills you, not after.",
    },
    {
      title: "Append-only audit trail",
      body: "Every approval and every blocked egress is written once and never edited, so the record can't drift from what happened.",
    },
    {
      title: "Per-agent scoped credentials",
      body: "Each agent only ever receives the secrets its job needs. The research agent reads its crawl token and never your payment keys.",
    },
    {
      title: "Egress allowlists",
      body: "When you enable it, agent sessions can only reach the domains you list; anything else is denied and flagged to the audit trail.",
    },
    {
      title: "Roles for your team",
      body: "Owners, approvers, and viewers. Only approvers clear approvals; viewers look but can't touch.",
    },
  ],
  guaranteesTitle: "Built and enforced today",
  /** NOT built / NOT certified. Each carries an explicit status so it can never be read as a claim. */
  roadmapTitle: "On the roadmap — not yet",
  roadmap: [
    { title: "SOC 2 Type II", status: "Planned — not yet certified", body: "We're building toward an audit. We are not certified today and don't claim to be." },
    { title: "GDPR data-processing agreement", status: "Planned — not yet offered", body: "A formal DPA and the tooling behind it are on the roadmap, not shipped." },
    { title: "SSO / SAML", status: "Designed seam — not yet built", body: "The wiring point exists in the code; no identity provider is connected yet." },
    { title: "Kernel-level network policy", status: "Partial — application-enforced today", body: "Egress is enforced at the application layer now; in-sandbox kernel enforcement is the next step." },
  ],
  notClaimedTitle: "What we don't claim",
  notClaimed:
    "We hold no third-party security certifications today. This page describes mechanisms we built, not audits we passed. When that changes, this page will say so — with a date.",
  backCta: "Back to home",
  /** The footer/nav link label that points visitors at this page. */
  navLabel: "Security & trust",
} as const;

/**
 * The seven named department agents (#123 fleet) → their department key. Each agent wears its
 * department's spectrum hue on its avatar pop-mark and name chip (#145). Keyed by the lowercased
 * display name so a directory entry ("Scout", "Echo", …) resolves straight to a colour.
 */
export const AGENT_DEPARTMENT: Readonly<Record<string, keyof typeof DEPARTMENT_SPECTRUM>> = {
  scout: "seo",
  echo: "social",
  quill: "content",
  postmark: "email",
  bid: "ads",
  lens: "analytics",
  mark: "brand",
};

/**
 * The spectrum colour for an agent, by display name. Falls back to the generic agent violet
 * (`--agent`) for any agent that isn't one of the seven named department leads, so non-fleet agents
 * still render as a coloured pop-mark rather than a grey shape (#145). Returns undefined for humans.
 */
export function agentColor(displayName: string | null | undefined): string | undefined {
  if (!displayName) return undefined;
  const first = displayName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const dept = AGENT_DEPARTMENT[first];
  return dept ? DEPARTMENT_SPECTRUM[dept] : "#b07bff";
}

/**
 * Applies brand-driven values that live outside React: the document title and the `--accent`
 * CSS custom property. Called once from `main.tsx` at boot. No-op fields keep the static
 * stylesheet defaults when the env vars are unset.
 */
export function applyBrand(brand: Brand = BRAND, doc: Document = document): void {
  doc.title = brand.title;
  doc.documentElement.style.setProperty("--accent", brand.accent);
}
