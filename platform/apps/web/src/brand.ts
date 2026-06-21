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
  // #387: ipop builds & runs companies, not just marketing — the tagline nods to that while keeping the
  // house voice. Still env-overridable (VITE_BRAND_TAGLINE) so a deployment can narrow it back.
  tagline:
    env.VITE_BRAND_TAGLINE ?? "An AI agency that builds & runs companies — you steer, they ship.",
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
  /** #469: the in-channel cancel control on the live-activity indicator. */
  stopRun: "Stop",
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
 * Connect-Slack settings copy (#170). The whole panel reads from here so there are no hardcoded
 * strings in the component (house rule: brand copy via VOICE). Warm, receipts-over-adjectives.
 */
export const SLACK_CONNECT = {
  title: "Connect Slack",
  hint:
    "Bring the fleet into your Slack. Paste your Slack app's bot token and signing secret below — " +
    "they're stored encrypted and never shown again. The agents reply in-thread, approvals come as " +
    "buttons, and your daily digest lands as a DM.",
  // #263: the manual token paste is tucked behind this collapsed disclosure — never a default free-text field.
  advancedSummary: "Connect Slack (advanced — paste app credentials)",
  botTokenLabel: "Bot token",
  botTokenPlaceholder: "xoxb-…",
  signingSecretLabel: "Signing secret",
  signingSecretPlaceholder: "Slack signing secret",
  connect: "Connect",
  disconnect: "Disconnect",
  connected: "Connected",
  notConnected: "Not connected",
  loading: "Loading…",
  error: "Couldn't update your Slack connection. Please try again.",
} as const;

/**
 * Connect external accounts (#192/#231) — the venture-operating accounts the fleet acts THROUGH (a
 * hosting/publish account, an email-sending domain/ESP, analytics, ads, payments). Human-once connect,
 * agent-forever operation. All copy lives here (house rule: no hardcoded strings in product chrome).
 */
export const EXTERNAL_ACCOUNTS = {
  title: "Connect external accounts",
  hint:
    "Your fleet acts in the real world through these accounts. Connect them once — the agents use " +
    "them forever. Keys are stored encrypted and never shown again.",
  loading: "Loading…",
  neededTitle: "To do real work, connect:",
  allConnected: "All set — every account a venture needs for real work is connected.",
  noneYet: "No external accounts connected yet.",
  connectedBadge: "Connected",
  pendingBadge: "Needs setup",
  kindLabel: "Account type",
  keyLabel: "Account name",
  keyPlaceholder: "e.g. sendgrid-prod",
  secretLabel: "Key or token",
  secretPlaceholder: "Paste the account key or token",
  connect: "Connect",
  disconnect: "Disconnect",
  // #263: the manual key/token paste is tucked behind this collapsed disclosure — never a default field.
  advancedSummary: "Connect an account manually (advanced)",
  error: "Couldn't update the connection. This workspace may need external onboarding enabled first.",
  kinds: {
    hosting: "Hosting / publishing",
    esp: "Email sending (ESP)",
    registrar: "Domain registrar",
    analytics: "Analytics",
    ad_account: "Ads / social",
    payment: "Payments",
    other: "Other API",
  } as Readonly<Record<string, string>>,
} as const;

/**
 * Settings → Connections (#258): the OAuth-first "connect once, the agents do the rest" surface. Customer
 * connectors are consumer OAuth ("Sign in with Google", "Connect X") — connect once and the fleet runs your
 * marketing. The internal site-publishing connector (admin only) is the one paste path. Connector labels +
 * summaries come from the server registry (data) — only this chrome copy lives here.
 */
export const CONNECTIONS = {
  title: "Connections",
  hint:
    "Connect your accounts once — your fleet does the setup and the work. No code, no copy-paste keys. " +
    "You only ever grant access once and approve real spend.",
  loading: "Loading…",
  comingSoon: "Coming soon",
  connect: "Connect",
  connectedBadge: "Connected",
  disconnect: "Disconnect",
  internalTitle: "Site publishing (admin)",
  internalHint: "Internal publishing connection — admin only. Not shown to customers.",
  repoLabel: "Repository (owner/repo)",
  repoPlaceholder: "owner/repo",
  branchLabel: "Base branch",
  branchPlaceholder: "main",
  tokenLabel: "Access token",
  tokenPlaceholder: "Paste the token",
  internalConnect: "Connect publishing",
  error: "Couldn't update the connection.",
} as const;

/**
 * Settings → Agent Garden (#284): browse the department fleet and switch each agent on/off per workspace.
 * Every word lives here so the panel carries no hardcoded brand copy (enforced by brand.test.ts). The agent
 * names, summaries and capabilities come from the server (the #282 contract, sanitized) — only the chrome
 * copy is here.
 */
export const GARDEN = {
  title: "Agent Garden",
  hint:
    "Your department agents. Switch on the ones you want working for you. " +
    "Outbound agents need your approval before they can act — nothing leaves the building without your yes.",
  loading: "Loading your agents…",
  empty: "No agents to show yet.",
  rollout: "The Agent Garden is rolling out for your workspace.",
  on: "On",
  enable: "Switch on",
  disable: "Switch off",
  pending: "Awaiting your approval",
  needsApproval: "Needs your approval",
  riskReadOnly: "Reads only",
  riskInternalDraft: "Drafts for review",
  riskExternalSend: "Acts outside",
  error: "Couldn't update that agent.",
} as const;

/**
 * Settings → Brand kit (#271): the one-time brand identity the owner sets (logo, colours, voice). Mark
 * enforces it and the fleet draws from it to generate on-brand images. Every word lives here so the
 * panel carries no hardcoded brand copy (enforced by brand.test.ts).
 */
export const BRAND_KIT = {
  title: "Brand kit",
  hint:
    "Set your brand once — colours, voice, and logo. Mark enforces it, and the rest of the fleet draws " +
    "from it so every image and post is on-brand.",
  loading: "Loading…",
  connectedBadge: "Brand kit set",
  unsetBadge: "Not set yet",
  nameLabel: "Brand name",
  namePlaceholder: "e.g. Acme",
  paletteLabel: "Brand colours",
  paletteHint: "Add your colours as #rrggbb hex. The first colour is the primary (the lead).",
  addColor: "Add colour",
  removeColor: "Remove",
  voiceLabel: "Brand voice",
  voicePlaceholder: "e.g. Confident and friendly. Plain words, no jargon. Never salesy.",
  logoLabel: "Logo asset id (optional)",
  logoPlaceholder: "An uploaded asset id, if you have one",
  save: "Save brand kit",
  saving: "Saving…",
  saved: "Brand kit saved.",
  error: "Couldn't save the brand kit. Check that every colour is a valid #rrggbb hex.",
  assetCount: (n: number): string => (n === 1 ? "1 on-brand asset" : `${n} on-brand assets`),
} as const;

/**
 * Settings → "What are we marketing?" (#502). Point the fleet at a target — your own product OR any external
 * app/URL — and the whole department reads this as their brief. All copy lives here so the panel carries no
 * hardcoded brand strings (enforced by brand.test.ts).
 */
export const MARKETING_TARGET = {
  title: "What are we marketing?",
  hint:
    "Point the fleet at a product — your own, or any app or site. Every agent reads this as their brief, so " +
    "they market this product instead of guessing.",
  loading: "Loading…",
  configuredBadge: "Target set",
  unsetBadge: "Not set yet",
  nameLabel: "Product or app name",
  namePlaceholder: "e.g. Acme Invoicing",
  urlLabel: "Website or app URL",
  urlPlaceholder: "e.g. acme.com",
  positioningLabel: "One-line positioning",
  positioningPlaceholder: "e.g. The fastest way for freelancers to get paid.",
  audienceLabel: "Target customer",
  audiencePlaceholder: "Who is it for? e.g. Solo freelancers and small studios in the US.",
  competitorsLabel: "Competitors",
  competitorsPlaceholder: "e.g. FreshBooks, Wave, Bonsai",
  previewLabel: "The brief the fleet will read",
  previewEmpty: "Fill in a field above to see the brief your agents will work from.",
  save: "Save target",
  saving: "Saving…",
  saved: "Target saved. The fleet will market this from now on.",
  error: "Couldn't save the target. Add at least a name, URL, or positioning and try again.",
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
  reach: "#d6409f", // Comet (outbound) — magenta, closing the warm→cool→warm arc
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
  { handle: "comet", name: "Comet", department: "reach", personality: "Finds the people who just raised or just hired, and writes each one a single good line." },
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
  /** Stable plan key — mirrors `billing/plans.ts` `PlanKey`; carried into `/signup?plan=<key>`. */
  readonly key: string;
  readonly name: string;
  readonly price: string;
  readonly tagline: string;
  readonly featured: boolean;
  /** What you get — feature bullets, mirroring the server catalog so pricing reads from one truth. */
  readonly highlights: readonly string[];
}

/**
 * Copy for the #260 one-screen onboarding (enter your domain → Sign in with Google). Centralised here so
 * the screen reads the brand. `errors` maps the `?error=<code>` the OAuth routes redirect with to a
 * house-voice line — every failure lands the user back on this screen, never a dead end.
 */
export const ONBOARDING = {
  title: "Point us at your website",
  sub: "Enter your domain and sign in with Google. That's the whole setup — we take it from there.",
  domainLabel: "Your website",
  domainPlaceholder: "acme.com",
  googleCta: "Sign in with Google",
  reassurance: "One sign-in covers Search Console and Analytics. No passwords, no DNS, no copy-pasting keys.",
  needDomain: "Pop your website in first — something like acme.com.",
  errors: {
    invalid_domain: "That doesn't look like a domain. Try something like acme.com.",
    google_denied: "Looks like the Google sign-in was cancelled. Give it another go.",
    google_failed: "We couldn't finish signing you in with Google. Try once more.",
    email_unverified: "That Google account's email isn't verified yet — verify it with Google, then retry.",
    bad_state: "That sign-in link expired. Start again and you'll be in.",
    bad_request: "Something got lost on the way back from Google. Start again.",
    no_workspace: "We couldn't find a workspace for that account. Reach out and we'll sort it.",
    google_unavailable: "Google sign-in isn't switched on for this deployment yet.",
    generic: "That didn't pop. Give it another go.",
  },
  /** #300 low-commitment entry: the divider + link to the read-only sample workspace (no account needed). */
  sampleDivider: "Just want to look around?",
  sampleCta: "Explore a sample workspace",
} as const;

/**
 * Copy for the #300 read-only sample workspace — the low-commitment front door a prospect can explore
 * before granting any Google data scope. Centralised here so the screen reads the brand, not inline copy.
 */
export const SAMPLE = {
  title: "A sample workspace",
  sub: "This is what your agents hand you — a real deliverable, ready to review. Nothing here is live.",
  badge: "Read-only demo",
  back: "Sign in to get your own",
  empty: "The sample workspace isn't switched on for this deployment yet.",
  loading: "Loading the sample…",
  consequence: "Sign in and Scout produces this for your site — you approve anything before it ships.",
} as const;

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
    fleetSub: "Eight specialists, one channel each, all on the same team.",
    pricingTitle: "Pick your pop",
    pricingSub: "Start small, grow when you feel like it.",
    pricingCta: "See all plans",
    ctaTitle: "Your new marketing team is waiting.",
    ctaSub: "We don't drink coffee, we don't take weekends, and we've already had three ideas.",
    ctaButton: "Hire the fleet",
  },
  /** Mirrors `billing/plans.ts` (#125): Starter → Pro → Agency, ascending price. Keys + highlights
   *  mirror the server catalog so the marketing page, the signup hand-off, and checkout agree. */
  plans: [
    {
      key: "starter",
      name: "Starter",
      price: "$49",
      tagline: "Your first three agents.",
      featured: false,
      highlights: ["3 agent seats", "$200/mo session budget", "1 department fleet", "Approvals + audit trail included"],
    },
    {
      key: "pro",
      name: "Pro",
      price: "$199",
      tagline: "A team that never sleeps.",
      featured: true,
      highlights: ["10 agent seats", "$1,000/mo session budget", "3 department fleets", "Priority autonomy + deploy-to-live"],
    },
    {
      key: "agency",
      name: "Agency",
      price: "$499",
      tagline: "A whole building of agents.",
      featured: false,
      highlights: ["30 agent seats", "$5,000/mo session budget", "10 department fleets", "Everything in Pro, at scale"],
    },
  ] as readonly PlanTeaser[],
  /** Sticky in-page anchor nav (#165). Jump links to the page's own sections — the product's own chrome. */
  anchors: [
    { href: "#how", label: "How it works" },
    { href: "#agents", label: "Agents" },
    { href: "#pricing", label: "Pricing" },
    { href: "#faq", label: "FAQ" },
  ],
  /** Footer columns (#165): real product links where they exist, honest placeholders where they don't. */
  footer: {
    productTitle: "Product",
    product: [
      { href: "#how", label: "How it works" },
      { href: "#agents", label: "The department" },
      { href: "#pricing", label: "Pricing" },
      { href: "/security", label: "Security & trust" },
    ],
    resourcesTitle: "Resources",
    resources: [
      { href: "/guides", label: "Guides" },
      { href: "/stories", label: "Stories" },
      { href: "/changelog", label: "Changelog" },
      { href: "/compare", label: "Compare" },
    ],
    socialTitle: "Find us",
    /** Placeholder handles — wired when the accounts exist (honest, never a dead promise). */
    social: [
      { key: "x", label: "X / Twitter", href: "/social/x" },
      { key: "linkedin", label: "LinkedIn", href: "/social/linkedin" },
      { key: "github", label: "GitHub", href: "/social/github" },
    ],
  },
} as const;

/**
 * The dedicated public pricing page (#214). The landing teases pricing in-page (`BillingScreen`); this
 * is the focused, shareable, link-out destination an ad or a price-shopping visitor lands on — a clean
 * three-plan comparison with "what you get" bullets and one CTA per plan that carries the chosen plan
 * into signup (`/signup?plan=<key>`). The plans come from {@link LANDING.plans} (one pricing truth), so
 * this page adds no second copy of prices. The signup form then frames the chosen plan as a free trial
 * with no card — the friction-light hand-off into the activated trial.
 */
export const PRICING = {
  eyebrow: "Plans & pricing",
  title: "Pick your pop.",
  sub: "Start free — no card. Pick a plan when the work pays for itself. Change or cancel any time.",
  /** Accessible label for the plans grid region (distinct from the hero heading). */
  plansLabel: "Plans",
  perMonth: "/mo",
  /** The one recommended-tier ribbon. */
  popularBadge: "Most popular",
  /** Per-plan CTA — starts a free trial of that tier. */
  planCta: "Start free",
  /** Reassurance under the grid (honest: free trial, no card, you set the ceiling). */
  footnote: "Every plan starts on a free trial — no card up front. Agent compute is billed against a cap you set; we never cross it.",
  /** A couple of pricing-specific questions, surfaced from the FAQ by question text (no copy duplicated). */
  faqMatch: [/cost/i, /free/i] as readonly RegExp[],
  faqTitle: "Pricing questions",
  /** Back to the full story. */
  backLabel: "← Back to the homepage",
  /** Signup trial framing (#214). `plan` is the chosen plan's display name. */
  trial: {
    eyebrow: "Free trial",
    onPlan: (plan: string): string => `You're starting the ${plan} plan — free to try, no card up front.`,
    generic: "Start free — no card up front. Pick a plan whenever the work pays for itself.",
  },
} as const;

/**
 * The landing's full workspace simulation (#165) — the hero is no longer a card, it IS the product.
 * A faithful, static-data render of the ipop console: the complete sidebar (pinned + every department
 * channel + DMs, with the ⌘K search), and a whole day's agent timeline in #seo that auto-plays and
 * loops. The arc tells one true story: a brief goes in, Scout audits with receipts, Quill drafts, QA
 * runs, an approval card pops, the human says yes, Postmark queues the send, and Lens reports the lift
 * with real numbers. Every word lives here so the simulation components carry no hardcoded copy
 * (brand.test scans them). The colours come from {@link DEPARTMENT_SPECTRUM}.
 */
export type Dept = keyof typeof DEPARTMENT_SPECTRUM;

/** One sidebar row: a channel or a DM. `dept` keys its spectrum dot; `unread` shows the count badge. */
export interface SimChannel {
  readonly name: string;
  readonly dept?: Dept;
  readonly unread?: number;
  readonly active?: boolean;
  /** For DMs: whether the correspondent is an agent (coloured dot) or a human (initials chip). */
  readonly kind?: "human" | "agent";
}

/** A grouped section of the sidebar (Pinned / Departments / Direct messages). */
export interface SimSidebarSection {
  readonly title: string;
  readonly items: readonly SimChannel[];
}

/**
 * One entry in the day-arc timeline. A discriminated union so each kind renders as its true in-app
 * surface: a chat message, an inline task card, a QA result block, or an approval card with the human's
 * reply. `time` is a wall-clock label ("9:02") so the day visibly progresses.
 */
export type SimEntry =
  | {
      readonly kind: "message";
      readonly time: string;
      readonly from: "you" | string;
      readonly dept?: Dept;
      readonly text: string;
      /** Optional thread affordance ("3 replies") — the console threads replies under a message. */
      readonly thread?: string;
      /** Marks the closing line that fires the confetti pop. */
      readonly done?: boolean;
    }
  | {
      readonly kind: "task";
      readonly time: string;
      readonly id: string;
      readonly title: string;
      readonly status: string;
      readonly dept: Dept;
      readonly assignee: string;
    }
  | {
      readonly kind: "qa";
      readonly time: string;
      readonly from: string;
      readonly dept: Dept;
      readonly passed: number;
      readonly total: number;
      readonly note: string;
    }
  | {
      readonly kind: "approval";
      readonly time: string;
      readonly dept: Dept;
      readonly title: string;
      readonly detail: string;
      readonly requestedBy: string;
      readonly pendingLabel: string;
      readonly approveLabel: string;
      readonly rejectLabel: string;
      readonly decidedLabel: string;
      readonly reply: string;
    };

export const WORKSPACE = {
  /** The console window's title bar / active channel. */
  activeChannel: "#seo",
  activeChannelTopic: "On-page SEO, crawl health, and the pre-launch audit.",
  /** The ⌘K omni-search affordance at the top of the sidebar. */
  searchPlaceholder: "Search or jump to…",
  searchHint: "⌘K",
  workspaceName: "Acme — workspace",
  sidebar: [
    {
      title: "Pinned",
      items: [
        { name: "#launch", unread: 2 },
        { name: "#general" },
      ],
    },
    {
      title: "Departments",
      items: [
        { name: "#seo", dept: "seo", active: true, unread: 4 },
        { name: "#social", dept: "social" },
        { name: "#content", dept: "content", unread: 1 },
        { name: "#email", dept: "email" },
        { name: "#ads", dept: "ads" },
        { name: "#analytics", dept: "analytics" },
        { name: "#brand", dept: "brand" },
        { name: "#reach", dept: "reach" },
      ],
    },
    {
      title: "Direct messages",
      items: [
        { name: "Scout", dept: "seo", kind: "agent" },
        { name: "Quill", dept: "content", kind: "agent" },
        { name: "Priya (you)", kind: "human" },
      ],
    },
  ] as readonly SimSidebarSection[],
  /** The whole day, in order. Auto-plays one entry at a time; reduced-motion shows it all at once. */
  timeline: [
    { kind: "message", time: "9:02", from: "you", text: "Morning @scout — can you do a full SEO pass on the site before Thursday's launch?" },
    { kind: "message", time: "9:03", from: "scout", dept: "seo", text: "On it. Crawling all 24 pages the way Google does — give me ten minutes." },
    { kind: "task", time: "9:05", id: "T-12", title: "Pre-launch SEO audit — homepage + /pricing", status: "IN PROGRESS", dept: "seo", assignee: "Scout" },
    { kind: "message", time: "9:14", from: "scout", dept: "seo", text: "Found 5 issues. Biggest: meta description missing on /pricing, and two images on /home have no alt text. Drafting fixes.", thread: "3 replies" },
    { kind: "message", time: "9:15", from: "quill", dept: "content", text: "I'll write a 58-character description for /pricing that sounds like us, not a robot." },
    { kind: "qa", time: "9:21", from: "Scout", dept: "seo", passed: 14, total: 14, note: "Re-crawled after the fix — caught a 2px layout shift on iOS Safari and corrected it." },
    {
      kind: "approval",
      time: "9:22",
      dept: "content",
      title: "Publish meta description on /pricing",
      detail: "“Hire a whole marketing team of AI agents — you approve every send.” · 58 chars · Quill",
      requestedBy: "Quill",
      pendingLabel: "Waiting on you",
      approveLabel: "Approve",
      rejectLabel: "Send back",
      decidedLabel: "Approved by you",
      reply: "ship it ✅",
    },
    { kind: "message", time: "9:25", from: "postmark", dept: "email", text: "Queued the launch note to 3 lists (4,210 people). Held as drafts — nothing sends without your yes." },
    { kind: "message", time: "16:30", from: "lens", dept: "analytics", text: "End of day: /pricing impressions +18%, newsletter open rate +4.2%. Tidy work, team. 🎉", done: true },
  ] as readonly SimEntry[],
} as const;

/**
 * The two staged vignettes used as section visuals (#165): a live approvals drawer that flips from
 * pending to approved (with the confetti micro-burst), and the #147 mission-control strip showing live
 * sessions and a running spend estimate against the cap. Pure data; the components animate the reveal.
 */
export const APPROVALS_VIGNETTE = {
  title: "Approvals",
  subtitle: "Nothing leaves the building without a human yes.",
  pendingTag: "Pending",
  approvedTag: "Approved",
  approveLabel: "Approve",
  rejectLabel: "Send back",
  items: [
    { id: "AP-118", dept: "email" as Dept, who: "Postmark", what: "Send launch announcement to 3 lists (4,210 recipients)" },
    { id: "AP-117", dept: "social" as Dept, who: "Echo", what: "Publish 5 launch-week posts to LinkedIn" },
    { id: "AP-116", dept: "ads" as Dept, who: "Bid", what: "Raise the /pricing campaign budget to $40/day" },
  ],
} as const;

export const MISSION_CONTROL = {
  title: "Mission control",
  subtitle: "Every agent, what it's doing, and what it's spending — live.",
  liveLabel: "Live now",
  spendLabel: "Spend today",
  spend: "$2.40",
  spendCap: "of $50 cap",
  decisionsLabel: "Decisions logged",
  decisions: "247",
  sessions: [
    { dept: "seo" as Dept, who: "Scout", task: "Crawling /blog for broken links", elapsed: "4m" },
    { dept: "content" as Dept, who: "Quill", task: "Drafting 3 product-page rewrites", elapsed: "11m" },
    { dept: "analytics" as Dept, who: "Lens", task: "Building the weekly numbers digest", elapsed: "2m" },
  ],
} as const;

/**
 * The four numbered story sections (#165), Innocent-school voice. Each pairs a claim with a product-true
 * visual: the department roster, the overnight mission-control strip, the approvals drawer, and the
 * remembered-decisions ledger. `visual` names which component the section renders beside its copy.
 */
export interface StorySection {
  readonly n: string;
  readonly title: string;
  readonly body: string;
  readonly visual: "department" | "mission" | "approvals" | "memory";
}

export const STORY: readonly StorySection[] = [
  {
    n: "01",
    title: "A whole department, not a chatbot",
    body:
      "Most AI tools give you one assistant and a blinking cursor. ipop gives you eight specialists — SEO, " +
      "content, social, email, ads, analytics, brand, outbound — each in its own channel, each genuinely good at one job.",
    visual: "department",
  },
  {
    n: "02",
    title: "They work while you sleep",
    body:
      "Brief them before bed and wake up to drafts, audits, and a tidy summary. The agents don't take " +
      "weekends, don't need a stand-up, and never lose the thread.",
    visual: "mission",
  },
  {
    n: "03",
    title: "Nothing leaves without your yes",
    body:
      "Every outbound send, every spend, every public change pauses for a human. Agents draft and queue; " +
      "you approve the good ones with a tap. The brakes are on by default.",
    visual: "approvals",
  },
  {
    n: "04",
    title: "Every decision, remembered",
    body:
      "Approvals, rejections, and the reasons behind them are written down once and kept. The team's memory " +
      "compounds — so today's call informs next month's, and nothing gets re-litigated.",
    visual: "memory",
  },
];

/** The remembered-decisions ledger (story 04 visual): an append-only audit row sample. */
export const MEMORY_LEDGER = {
  title: "Decision log",
  subtitle: "Append-only. Written once, never edited.",
  rows: [
    { time: "9:24", who: "You", text: "Approved /pricing meta description", tag: "Approved" },
    { time: "9:31", who: "You", text: "Sent back the LinkedIn carousel — too salesy", tag: "Returned" },
    { time: "10:02", who: "You", text: "Approved $40/day on the /pricing campaign", tag: "Approved" },
  ],
} as const;

/**
 * Console redesign copy (board + standup, per the approved brand-book mockup). The new primary surface
 * is a Conductor-style standup (left: Board/Reports/History + projects→sessions) beside a kanban board
 * (In motion / Waiting on you / Shipped), with a slide-over peek drawer and a per-project settings sheet.
 * Every string lives here so the console components carry no hardcoded brand copy (house rule; the chrome
 * scan in brand.test.ts is the backstop). Voice: warm, first-person plural, receipts over adjectives —
 * the moments (empty states, the brief, the banner) carry the personality; the chrome stays quiet.
 * One status grammar everywhere: braille = running · vermilion dot = waiting on you · green = shipped.
 */
export const CONSOLE = {
  /** Left-panel primary nav. */
  nav: { board: "Board", reports: "Reports", history: "History" },
  /** Projects group header + its two hover actions. A project = one repo = one company. */
  projects: {
    label: "Projects",
    filterTitle: "Only what needs you",
    newTitle: "New project",
    /** The always-present left-rail control that stands up the founding team (#123/#138 seed seam). */
    start: "Start a venture",
    startTitle: "Start a venture — hire your founding team",
    newSession: "New session",
    settings: "Project settings",
  },
  /**
   * First-run activation: a fresh workspace has no projects and a dead board. Rather than a void, this
   * walks the owner to their first running project in under a minute by hiring the founding team (the real
   * #123/#138 department seed — the same seam #187's venture-factory bootstrap uses). Nothing faked.
   */
  firstRun: {
    eyebrow: "New here",
    headline: "Your company's an empty desk. Let's staff it.",
    sub: "Hire your founding team — seven departments, each with a named lead — and hand them their first brief. About a minute from here to your first running task.",
    steps: [
      { k: "team", title: "Hire the team", body: "Seven departments — growth, product, design and the rest — each led by a named agent." },
      { k: "work", title: "They clock in", body: "Every lead opens their first task the moment they're hired. You'll watch the board fill up." },
      { k: "control", title: "You hold the keys", body: "Only money needs your yes — a charge, a payout, real spend. Everything else the fleet ships on its own, every step on the record." },
    ],
    cta: "Start your first venture",
    ctaBusy: "Hiring your team…",
    ctaError: "That didn't take — give it another go.",
    /** Shown when the seed is rate-limited (429). Pairs with {@link consoleSeedRetryNote} for the countdown. */
    rateLimited: "You're going a little fast.",
    /** The retry button label while the founder is held off (disabled until Retry-After elapses). */
    retryWait: "Hang on a moment…",
    /** The retry button label once the cool-off has elapsed. */
    retryNow: "Try again",
    /** Shown when the team can't run because no Claude runtime is connected — routes to Settings. */
    connectError: "Your team can't run yet — connect Claude so they can actually clock in.",
    connectErrorCta: "Connect Claude",
    assembling: "Your team's clocking in. The board fills in as each lead opens their first task — hang tight.",
    connectHint: "Bringing your own Claude? Connect it in Settings so the team can actually run.",
    connectCta: "Open Settings",
    /**
     * First-run auto-deliverable (#301): the moment a fresh workspace lands on the board, Scout quietly
     * takes a real, no-spend first pass — an SEO audit of the workspace's own site — so the owner has
     * something useful to look at within the first minute, with zero setup. The handle is a department
     * lead id (not a brand string); the goal is the brief Scout runs.
     */
    autoLead: "scout",
    autoGoal:
      "Audit our website's homepage for SEO and summarise the top quick wins — title, meta description, headings, and crawlability. No spend, no changes; just the findings.",
  },
  /**
   * Calm "warming up" state (#299): a fresh workspace's first sessions can hit transient runner/spawn
   * issues before the team is fully on the board. The console NEVER shows raw runner or exit-code errors;
   * it shows this branded, reassuring state and silently retries in the background until a real
   * deliverable lands. No exit codes, no internal class names — just the promise that work is coming.
   */
  warmingUp: {
    headline: "Your team is warming up…",
    sub: "Getting your first deliverable ready. This takes a moment on a brand-new workspace — nothing for you to do.",
  },
  /**
   * Deliverable cards (#302): a completed agent session surfaces as a board card. The raw agent prompt is
   * never the title and the internal `agent.deliverable` type id never shows. Each card carries a human
   * title (the work itself), a short preview of what the agent produced, and — while it awaits review — a
   * plain "what happens if I approve" line. The human action labels below replace every raw type id.
   */
  deliverable: {
    /** Fallback title when the task text is empty/unreadable. */
    untitled: "New deliverable",
    /** The lifecycle word shown on a card by lane (never "ready for review" on a Done card). */
    review: "Needs your review",
    shipped: "Accepted",
    /** The "what happens if I approve" line under a deliverable awaiting review. */
    consequence: "Approve to accept this draft — nothing is sent or charged.",
    /** Shown when a completed session produced no work product (only explored/narrated) — never a
     * misleading "approve this draft" on a card that has nothing to review. */
    noDeliverable: "No deliverable yet — still working",
    /** Human labels for the action types that reach the board, so a raw `x.y` id never renders. */
    actionLabels: {
      "agent.deliverable": "Deliverable",
      "external.send": "Outbound send",
      "billing.refund": "Refund",
      "billing.charge": "Charge",
      "billing.payout": "Payout",
    } as Record<string, string>,
    /** Fallback action label for any unmapped type — still human, never the raw id. */
    actionFallback: "Action",
  },
  /** The three board lanes (console v5). A card runs left→right: Work in progress → Spend approval →
   * Done. The middle lane holds ONLY money decisions (#243): a human approves what spends money; every
   * non-money item (drafts, posts, publishes, sends) flows straight to Done on its own. These are the
   * only column titles — the whole product is one board. */
  columns: { running: "Work in progress", waiting: "Spend approval", shipped: "Done" },
  /** The one quiet legend line under the header: department = the 3px card edge. */
  legend: { caption: "edge colour = department" },
  /** Fleet-health dot copy (header). */
  health: { healthy: "fleet healthy", attention: "needs a human" },
  /**
   * Connection-health chip (#365) — the at-a-glance "is the fleet actually able to run?" signal in the
   * header. Shown only for the named owner workspace (default-OFF, owner-first via `connect-health-flag`).
   * `connected` is a quiet confirmation; `notConnected`/`expired` are a button that opens Settings →
   * Connect Claude — the one owner action that unlocks real agent runs on the subscription token.
   */
  connectHealth: {
    /** Accessible label for the chip. */
    label: "Claude connection",
    connected: "Claude connected",
    notConnected: "Connect Claude to run your fleet",
    expired: "Reconnect Claude — token stopped working",
  },
  /**
   * Deploy-freshness banner (#366) — shown ONLY when the web bundle and the API report different build
   * SHAs (a stale Vercel deploy vs a newer api.ipop.ai, or a preview bundle hitting prod). Gated default-OFF
   * + owner-first; renders nothing on a match or when either side is unstamped (unknown), so it never
   * false-alarms. This is the front-end half of the #292 version-advance discipline.
   */
  versionCheck: {
    label: "Build version mismatch",
    title: "This page is out of sync with the API",
    body: "The web app and the API are running different builds — what you see may lag the live fleet. Refresh; if it persists, the stale side needs a redeploy.",
    refresh: "Reload page",
  },
  /** Spend-gauge forecast labels + the inline upgrade CTA (the in-header path to a paid plan). */
  gauge: { onTrack: "on track", atRisk: "at risk", noCap: "no cap set", upgrade: "Upgrade" },
  /** Confirmation banner shown when a customer lands back in the app from a completed checkout. */
  checkoutReturn: {
    success: "You're upgraded — your new plan and cap are live. Thanks for backing the fleet. 🎉",
    dismiss: "Dismiss",
  },
  /** Status-grammar words used on rows + cards. */
  status: { yourYes: "your yes", running: "working", shipped: "shipped", idle: "idle", sending: "sending" },
  /** Card chrome. The ▲ marks an approval-needed card (its ask line); the card opens the drawer. */
  card: { why: "why?", approve: "Approve", sendBack: "Send back", askPrefix: "▲", waiting: "waiting", est: "est.", stop: "Stop" },
  /** The drawer — the single "dive in" surface (console v5). Open any card or session row into it. */
  peek: {
    /** Section title above the live step trail. */
    doing: "What it's doing",
    /** The audit-trail link under the steps; flips the drawer to the receipts we actually hold. */
    why: "why did it do this? →",
    whyHint: "Every step is logged.",
    /** The approval pair, decided through the #13 gate. */
    approve: "Approve",
    notYet: "Not yet",
    notYetReason: "Sent back for another pass.",
    steerPlaceholder: "Steer this task…",
    followUpPlaceholder: "Reopen or ask a follow-up…",
    send: "Send",
    auditStatus: "audit trail",
    whyPrefix: "why",
    back: "← back to steps",
    emptyTranscript: "Nothing logged yet. Brief them and the steps start landing here.",
    held: "Ready when you are — anything that spends money waits for your yes.",
    /** Drawer status line, by item kind (the shared status grammar, in words). */
    statusRunning: "working",
    statusWaiting: "needs your yes",
    statusShipped: "done",
  },
  /** Two-pane shell utilities (console v5 has no top nav; these live in the left-panel footer/header). */
  shell: {
    signOut: "Sign out",
    settings: "Settings",
    settingsTitle: "Workspace settings",
    approvalsTitle: "Approvals",
    mentions: "Mentions",
    closeSettings: "Close",
  },
  /** First-run setup checklist (#479): the guided path from signup to first real output. */
  firstRunChecklist: {
    title: "Get set up",
    progress: (done: number, total: number): string => `${done} of ${total} done`,
    dismiss: "Hide",
    steps: {
      brand: { label: "Set your brand", hint: "Name, palette, and voice so the team sounds like you.", cta: "Set brand" },
      connect: { label: "Connect an account", hint: "Link one place your work goes out — the agents take it from there.", cta: "Connect" },
      run: { label: "Run an agent", hint: "Ask a teammate in any channel, e.g. “@scout audit our homepage.”", cta: "Got it" },
      approve: { label: "See & approve the result", hint: "Review what the team drafted and give it the green light.", cta: "Review" },
    },
  },
  /**
   * The agent-coordination surface (#352) — the reload.chat-style channels/messages/members view, re-mounted
   * behind the default-OFF, owner-workspace-first coordination flag. Read + steer only; no new action path.
   */
  coordination: {
    /**
     * The chat-first surface label (#372/#378) — for the named owner workspace the coordination view is the
     * WHOLE app (the team channel IS the home screen). Kept as the accessible region label.
     */
    open: "Coordination",
    /** Overlay + view title. */
    title: "Team coordination",
    /** One-line framing under the title. */
    sub: "Channels, threads, and live sessions — watch the fleet work together and steer in the open.",
    /** Accessible label for the live mission-control strip (#147). */
    liveLabel: "Live sessions",
    /**
     * Left-panel (reload.chat sidebar) copy (#378): the search box, the three section headers (PINNED /
     * CHANNELS / DIRECT MESSAGES), and the DM affordances. Centralised here so the rebuilt sidebar carries
     * no hardcoded brand copy. The channel/member names themselves are DATA (from the store), not copy.
     */
    sidebar: {
      searchPlaceholder: "Search channels…",
      searchHint: "⌘K",
      searchLabel: "Search channels and people",
      pinned: "Pinned",
      channels: "Channels",
      directMessages: "Direct messages",
      addChannel: "Add channel",
      newChannelPlaceholder: "New channel name",
      create: "Create",
      you: "you",
      /** No-results line under the search box when a query matches nothing. */
      noMatches: "Nothing matches that — try another search.",
    },
    /** Center-pane header for a DM (#378): a 1:1 with an agent/teammate, framed as a direct message. */
    dm: {
      title: "Direct message",
      /** Prefix before the peer's name in the pane header ("with Scout"). */
      withPrefix: "with",
    },
    /** Whole-app shell utilities for the chat-first surface (#378): the account row + approvals control. */
    shell: {
      settings: "Settings",
      signOut: "Sign out",
    },
  },
  /** Reports view sections. */
  reports: {
    overnightTitle: "While you were out",
    briefTitle: "Daily brief",
    handoversTitle: "Needs your call",
    handoverDispatch: "Approve",
    handoverEmpty: "No calls waiting. The fleet's running clean.",
    plTitle: "Weekly numbers",
    plOneNumber: "the one number that matters",
    /** #253 proof scorecard heading — real outcomes shipped on the product itself, not draft counts. */
    proofTitle: `Proof on ${BRAND.name}.ai`,
  },
  /** Per-project settings sheet: tab labels + field copy. */
  settings: {
    tabs: { general: "General", models: "Models", agents: "Agents", budget: "Budget", approvals: "Approvals" },
    general: {
      repoLabel: "REPOSITORY",
      repoHint: "one project = one repo = one company",
      voiceLabel: "BRAND VOICE",
      voiceHint: "every agent here inherits this",
      voiceDefault: "Warm, a little silly, never smug. Receipts over adjectives.",
    },
    models: {
      localLabel: "LOCAL · GEMMA",
      localHint: "voice + drafts on-device — nothing leaves this Mac",
      localConnected: "connected",
      keysHint: "keys are sealed per project, write-only — we use them, we can't read them back",
      noKey: "not connected",
      fingerprintPrefix: "saved ·",
      /** Cloud model providers shown as write-only key rows (brand-facing names live here, not inline). */
      providers: ["Anthropic", "OpenAI", "Google AI"],
    },
    agents: { hint: "the named department leads — toggle who's on the roster" },
    budget: {
      monthlyLabel: "MONTHLY BUDGET",
      monthlyHint: "hard stop — we queue politely when it's spent",
      capLabel: "PER-SESSION CAP",
      windowPrefix: "Spent this window",
    },
    approvals: {
      gateTitle: "Only money needs your yes",
      gateSub: "money moves are gated in code; the fleet ships everything else on its own",
      approverLabel: "APPROVERS",
      approverHint: "every yes is on the record",
    },
    close: "Done",
  },
  /** "While you were out" overnight banner (dismissible). */
  wyo: { title: "While you were out", read: "Read the brief", dismiss: "Dismiss" },
  /** Approval-empty state: the room is quiet because the fleet is trusted to run on its own. */
  approvalsClear: {
    headline: "All clear — we're running on our own.",
    nextDefault: "the next draft, when it's ready",
  },
  /**
   * The owner BRIEF composer (#235): a real input that turns the passive "@mention a lead to kick off the
   * next piece of work" into a working control. Pick a department lead, hand them a goal, and they clock in
   * on a real, approval-gated task — the board fills as they go. Generic by design (it serves every
   * workspace); the concrete venture #1 brief is seeded server-side. The `leads` are the seven department
   * leads (their @handles are the named department agents, not brand strings) — the five acquisition leads
   * plus Lens (analytics) and Mark (brand), so every department agent is briefable (#288).
   */
  brief: {
    eyebrow: "Brief the fleet",
    title: "Hand a lead a goal",
    sub: "Pick a department lead and tell them what to chase. They open a real task and the board fills up — only money needs your yes, the fleet ships everything else on its own.",
    leadLabel: "Who's it for?",
    leads: [
      { handle: "scout", name: "Scout", dept: "SEO", blurb: "keywords + articles to rank" },
      { handle: "echo", name: "Echo", dept: "Social", blurb: "posts + threads" },
      { handle: "quill", name: "Quill", dept: "Content", blurb: "drafts + long-form" },
      { handle: "postmark", name: "Postmark", dept: "Email", blurb: "sequences" },
      { handle: "bid", name: "Bid", dept: "Ads", blurb: "campaigns + budget" },
      { handle: "lens", name: "Lens", dept: "Analytics", blurb: "traffic + conversions to track" },
      { handle: "mark", name: "Mark", dept: "Brand", blurb: "voice + naming + positioning" },
    ],
    placeholder: "What should they go do? e.g. get us our first paying customers",
    submit: "Send the brief",
    submitting: "Briefing…",
    goalRequired: "Tell them what to chase first.",
    /** Outcome suffixes — the lead's name is prefixed by the helpers below. */
    launchedSuffix: "is on it — watch Work in progress.",
    connectSuffix: "is ready, but the team can't run yet — connect Claude in Settings.",
    error: "That didn't take — give it another go.",
  },
  /**
   * Brief a venture (#387) — the owner-facing surface that runs ANY company idea through the already-built
   * #96 venture loop (not just marketing). Default-OFF, owner-workspace-first. Submitting only sources the
   * idea + scores it; the funded build work still flows through the existing money/approval gates.
   */
  ventureBrief: {
    eyebrow: "Build a company",
    title: "Brief a venture",
    sub: "ipop doesn't just market itself — it can start and run any company you brief. Describe the idea and it enters the venture loop: scored against the bar, and if it clears, funded into a real build epic. Money still needs your yes.",
    fields: {
      name: { label: "Idea", placeholder: "What are we building? e.g. a payroll tool for clinics" },
      pitch: { label: "One-line pitch", placeholder: "The wedge in a sentence" },
      targetUser: { label: "Target customer", placeholder: "Who is it for? e.g. solo clinic owners" },
      problem: { label: "Problem", placeholder: "What painful thing does it fix?" },
      whyNow: { label: "Why now", placeholder: "The insight that makes this the moment" },
    },
    submit: "Brief the venture",
    submitting: "Briefing…",
    required: "Fill in every field so the loop has enough to score.",
    successPrefix: "Venture briefed —",
    error: "That didn't take — give it another go.",
  },
} as const;

/** A department lead the owner can brief (#235). */
export type ConsoleBriefLead = (typeof CONSOLE.brief.leads)[number];

/** "Scout is on it — watch Work in progress." — the brief-launched confirmation line. */
export function consoleBriefLaunched(name: string): string {
  return `${name} ${CONSOLE.brief.launchedSuffix}`;
}

/** "Scout is ready, but the team can't run yet…" — shown when no Claude is connected. */
export function consoleBriefConnect(name: string): string {
  return `${name} ${CONSOLE.brief.connectSuffix}`;
}

/** Overnight banner summary: shipped · needs-you · spend, in the house voice. */
export function consoleOvernightSummary(shipped: number, waiting: number, spend: string): string {
  const yes = waiting === 1 ? "needs your yes" : "need your yes";
  return `${shipped} shipped · ${waiting} ${yes} · ${spend} overnight`;
}

/** "N waiting on you" header chip — caller hides it at zero. */
export function consoleWaitingChip(n: number): string {
  return `${n} waiting on you`;
}

/** "N running" header pill (#384) — the calm live indicator that replaced the mission-control table; caller
 *  hides it at zero. */
export function consoleRunningPill(n: number): string {
  return `${n} running`;
}

/** Approval-empty "next likely ask" line. */
export function consoleNextAsk(hint: string = CONSOLE.approvalsClear.nextDefault): string {
  return `Next likely ask: ${hint}.`;
}

/** First-run seed rate-limit note (#221): the honest "retry in Ns" countdown beside the held retry button. */
export function consoleSeedRetryNote(seconds: number): string {
  return `${CONSOLE.firstRun.rateLimited} You can try again in ${seconds}s.`;
}

/**
 * The status-grammar running glyph (brand-defined): a braille spinner whose frames belong to the brand's
 * visual language ("braille = running"), so they live here beside the rest of the identity rather than in
 * a component. The spinner component cycles {@link brailleFrame}; under reduced motion it freezes to one.
 */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The braille frame for a tick (wraps both directions). Pure, so the spinner stays testable. */
export function brailleFrame(tick: number): string {
  const n = BRAILLE_FRAMES.length;
  return BRAILLE_FRAMES[((tick % n) + n) % n]!;
}

/**
 * Pricing framed as the product's own Settings → Billing screen (#165). The plans mirror `LANDING.plans`
 * (which mirror `billing/plans.ts`, #125); this just dresses them in the app's settings chrome so the
 * visitor sees exactly where they'll land. `currentPlan` is the one shown as the active subscription.
 */
export const BILLING = {
  settingsLabel: "Settings",
  billingLabel: "Billing",
  navItems: ["General", "Members", "Billing", "Security"],
  heading: "Plan & billing",
  subheading: "Pick your pop. Change or cancel any time — no calls, no contracts.",
  currentLabel: "Current plan",
  selectLabel: "Choose",
  perMonth: "/mo",
  /** Which plan renders as the currently-active subscription in the chrome. */
  currentPlan: "Pro",
  /** A couple of true-to-product line items under the plan cards. */
  footnote: "Usage-based agent compute is billed against your cap. You set the ceiling; we never cross it.",
  /**
   * The real, in-app Settings → Billing panel (not the landing mockup): current plan, this-window usage vs
   * cap, and a clearly-marked test-mode note. Reused by {@link BillingSettings}.
   */
  panel: {
    eyebrow: "Plan & billing",
    blurb: "See your plan and what you've used this window — upgrade any time, no calls, no contracts.",
    currentPlanLabel: "Current plan",
    trialPlan: "Free trial",
    usageLabel: "Usage this window",
    capSuffix: "cap",
    noCap: "no cap set",
    seatsSuffix: "seats",
    /** Clearly-marked safety note: live charges stay off until the owner connects Stripe. */
    testModeTitle: "Test mode — no live charges yet",
    testModeBody:
      "Checkout is wired end-to-end but runs in test mode. Going live (connecting Stripe and taking the first real payment) is the owner's call — until then nothing is charged.",
  },
} as const;

/**
 * The FAQ (#165): SEO-grade, substantive answers in the house voice. Centralised here so the FAQ
 * component stays copy-free (brand.test). Ordered most-asked first.
 */
export interface FaqItem {
  readonly q: string;
  readonly a: string;
}

export const FAQ = {
  title: "Questions, answered straight",
  subtitle: "No fine print, no dodging. If we haven't covered it, the contact form is right below.",
  items: [
    {
      q: "Are these real AI agents, or canned responses?",
      a: "Real agents. Each one runs a live model with tools — it crawls your site, reads your analytics, drafts copy, and reasons about what to do next. The timeline on this page is a faithful render of what the console actually shows.",
    },
    {
      q: "Which actions still need my approval?",
      a: "Money — and only money. A charge, a refund, a payout, connecting a live payment key, or real ad spend pauses for your yes, with the exact amount shown. Everything else — drafts, a published article, a non-paid outreach email, a deploy — the fleet ships on its own. The money gate is enforced in code, and automatic safeguards (a kill switch, suppression/opt-out honoring, and anti-injection on anything the agents read) run on every action without a prompt.",
    },
    {
      q: "What can the agents actually do?",
      a: "SEO audits, content drafts, social calendars, email campaigns, ad planning, analytics digests, brand-voice checks, and outbound prospecting. They research, write, and plan. They don't pretend to be human, and they don't act on the outside world without your yes.",
    },
    {
      q: "How is this different from ChatGPT or a single AI assistant?",
      a: "One assistant gives you a blank box and waits. ipop gives you a standing department — eight specialists in their own channels, working in parallel, with a shared memory and a human approval layer. It's a team, not a tab.",
    },
    {
      q: "Is my data safe? Can one customer see another's work?",
      a: "Every request is scoped to your workspace; tenants are fully isolated. Each agent only receives the credentials its job needs, and outbound network access can be locked to an allowlist. The honest details — including what we haven't built yet — live on our security page.",
    },
    {
      q: "What does it cost, and can I try it first?",
      a: "Start free, no card. Paid plans run from $49 to $499 a month, and agent compute is billed against a cap you set — we never cross it. You can change or cancel any time from the billing screen.",
    },
    {
      q: "What happens if an agent gets something wrong?",
      a: "It surfaces as a draft, not a live change, so a mistake costs you a glance, not a cleanup. You send it back with a note, the agent revises, and the whole exchange is logged so it learns the preference for next time.",
    },
    {
      q: "Do I need to be technical to use it?",
      a: "No. If you can send a Slack message, you can brief an agent — you @mention them by name and say what you need. There's no setup call, no Gantt chart, and no prompt-engineering homework.",
    },
    {
      q: "Can I keep my own tools and just add the agents?",
      a: "Yes. The agents work alongside what you already use — they draft into your channels and hand off the finished thing. You stay in control of where it goes.",
    },
  ] as readonly FaqItem[],
} as const;

/** Closing contact block (#165): a short reply, not a deck. */
export const CONTACT = {
  eyebrow: "Talk to a human",
  title: "Still chewing it over?",
  body: "Tell us what you're trying to do. You'll get a short, straight reply from a person — not a deck, not a drip campaign.",
  nameLabel: "Your name",
  emailLabel: "Email",
  messageLabel: "What are you hoping the fleet can do?",
  messagePlaceholder: "We publish twice a week and our SEO is a mess…",
  submitLabel: "Send it over",
  /** In-flight label while the lead is posting. */
  sendingLabel: "Sending…",
  /** Shown after the lead is captured (GAP 1, ADR-0400) — it now really persists + reaches a human. */
  sentNote: "Got it — your note's in. A person will read it and reply, usually within a day.",
  /** Shown if the post fails — honest, with a fallback so the lead is never silently lost. */
  errorNote: "That didn't go through. Mind trying again, or email us directly and we'll pick it up.",
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
      title: "Money approval gates",
      body: "Anything that moves money — a charge, a refund, a payout, real ad spend — pauses for a human to approve or reject, with the exact amount shown. Everything else the fleet ships on its own.",
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
 * The eight named department agents (#123 fleet) → their department key. Each agent wears its
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
  comet: "reach",
};

/**
 * The spectrum colour for an agent, by display name. Falls back to the generic agent violet
 * (`--agent`) for any agent that isn't one of the eight named department leads, so non-fleet agents
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

/**
 * The marketing-site machine (#153) — the public storefront the fleet maintains. Every word lives here
 * so the site components carry no hardcoded brand copy (brand.test scans them). The twist: every page is
 * footed with the content-agent credit, because the agents really did draft this site.
 */

/** Shared chrome for every marketing-site page: nav, footer credit, and the Ask-AI deep links. */
export const SITE = {
  nav: [
    { href: "/compare", label: "Compare" },
    { href: "/stories", label: "Stories" },
    { href: "/guides", label: "Guides" },
    { href: "/changelog", label: "Changelog" },
    { href: "/brand", label: "Brand" },
  ],
  ctaPrimary: "Start free",
  ctaSecondary: "Sign in",
  /** The dogfood credit on every content page — the agents drafted it, a human approved it. */
  maintainedBy: "This page is maintained by Quill, our content agent — drafted by AI, approved by a human.",
  /** Shown when a section or page has no published content yet (graceful, on-voice empty state). */
  empty: "Nothing published here yet. Quill's still drafting — check back soon.",
  /** Shown when the content API can't be reached (the page degrades instead of crashing). */
  offline: "We can't reach the content shelf right now. The agents are looking into it — try again shortly.",
  backToSite: "← Back",
} as const;

/**
 * The blog (#252): a prerendered, indexable surface where the fleet publishes in the open. Posts are
 * committed markdown (apps/web/content/blog/*.md); this block is just the chrome copy around them.
 */
export const BLOG = {
  path: "/blog",
  eyebrow: "From the department",
  title: "The ipop blog",
  sub: "SEO teardowns, content playbooks, and honest notes on AI marketing — written by the agents, steered by a human.",
  /** Byline prefix on each post ("By Scout, our SEO agent"). */
  byLabel: "By",
  /** Shown when there are no published posts yet (graceful, on-voice empty state). */
  empty: "Nothing published here yet. Quill and Scout are drafting — check back soon.",
  /** Shown when a /blog/<slug> doesn't resolve to a published post. */
  notFound: "We couldn't find that post. It may have moved, or it's still in drafts.",
  backToIndex: "← All posts",
} as const;

/** The GEO play (#153): footer links that pre-fill a prompt into the big AI assistants. */
export const ASK_AI = {
  heading: "Ask an AI about us",
  blurb: "Curious but don't trust our marketing? Fair. Ask a neutral third party — we'll even pre-fill the question.",
  /** The prompt pre-filled into each assistant. */
  prompt: "Explain ipop.ai to me — the marketing agency of AI agents. What is it, who is it for, and what's the catch?",
  providers: [
    { key: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com/?q=" },
    { key: "claude", label: "Claude", base: "https://claude.ai/new?q=" },
    { key: "perplexity", label: "Perplexity", base: "https://www.perplexity.ai/search?q=" },
  ],
} as const;

/** Build the Ask-AI deep links with the prompt URL-encoded into each provider's query param. */
export function askAiLinks(prompt: string = ASK_AI.prompt): { key: string; label: string; href: string }[] {
  const q = encodeURIComponent(prompt);
  return ASK_AI.providers.map((p) => ({ key: p.key, label: p.label, href: `${p.base}${q}` }));
}

/** Copy for the `/compare` index. The individual pages are repo markdown (drafted by Quill/Scout). */
export const COMPARE = {
  eyebrow: "Honest comparisons",
  title: "ipop vs. the alternatives",
  sub: "No strawmen. We'll tell you where the other option wins — and where a fleet that never sleeps does.",
} as const;

/** Copy for the `/stories` index. */
export const STORIES = {
  eyebrow: "Customer stories",
  title: "Receipts, not testimonials",
  sub: "Real setups, real numbers. First up: how our own fleet built and runs this very site.",
} as const;

/** Copy for the `/guides` index. */
export const GUIDES = {
  eyebrow: "Cornerstone guides",
  title: "How this actually works",
  sub: "Practical, honest walkthroughs — what AI agents do well, and exactly where a human still decides.",
} as const;

/** Copy for the `/changelog` index. */
export const CHANGELOG = {
  eyebrow: "Shipped",
  title: "What the fleet shipped",
  sub: "Drafted weekly by Echo from our merged pull requests, approved by a human before it's published.",
} as const;

/** A swatch on the `/brand` page. */
export interface BrandSwatch {
  readonly name: string;
  readonly hex: string;
  readonly usage: string;
}

/** Copy + assets for the `/brand` page — the pop marks, wordmark, palette, and voice from docs/brand. */
export const BRAND_ASSETS = {
  eyebrow: "Brand kit",
  title: "The pop, in one place",
  sub: "Marks, wordmark, palette, and voice. Use them when you write about us — and please keep the dot loud.",
  markTitle: "The Pop Mark",
  markBody: "A single vermilion dot — the popped i-dot, standing alone. It's our favicon, our splash, our signature.",
  wordmarkTitle: "The wordmark",
  wordmarkBody: "Lowercase, friendly, with the first i's dot popped in vermilion. Never set it in all-caps.",
  paletteTitle: "Palette",
  /** Paper / Ink / Vermilion — the three core colours from the brand book. */
  palette: [
    { name: "Paper", hex: "#f6f1e7", usage: "Backgrounds — warm, never stark white." },
    { name: "Ink", hex: "#171310", usage: "Text — soft black, never #000." },
    { name: "Pop Vermilion", hex: "#ff4524", usage: "The one loud colour. Use it sparingly, like a pop." },
  ] as readonly BrandSwatch[],
  voiceTitle: "Voice",
  voiceBody: "Warm, first-person plural, a little silly. Receipts over adjectives. Empty states are moments, not dead ends.",
  spectrumTitle: "Department spectrum",
  spectrumBody: "One hue per marketing function, a warm-to-cool arc anchored on Pop Vermilion.",
} as const;

/** Copy for the soft paywall nudge (#153 trial funnel). Honest: surfaces the real plan + the real cap. */
export const PAYWALL = {
  title: "You're flying — time for more runway",
  body:
    "Your free trial workspace hit a cap. Nothing's lost; your agents are just waiting on more room to work. " +
    "Pick a plan and they're back at it in seconds.",
  cta: "See plans",
  dismiss: "Not now",
  /** Shown as the small print under the nudge, naming the current plan. */
  onPlan: (planName: string): string => `You're on the ${planName} trial.`,
} as const;
