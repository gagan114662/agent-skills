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

/** Public human escalation path (#864): used by the contact fallback and footer links. */
export const SUPPORT_CONTACT = {
  email: "support@ipop.ai",
  href: "mailto:support@ipop.ai",
  label: "Email support",
} as const;

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
  emptyApprovals: "nothing waiting on you. go get a coffee - we'll shout if money needs a grown-up.",
  /** No agent sessions in a channel (Deploy / Review / Run rails). */
  noSessions: "No agent sessions here yet. Kick one off and it'll show up on this rail.",
  /** Deploy rail: a session is picked but nothing deployed. */
  pickSessionToDeploy: "Pick a session on the left and we'll ship its app to a live URL.",
  /** Founder console: nothing waiting. */
  noPendingApprovals: "nothing waiting on you. go get a coffee - we've got this.",

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
  /** Composer Queue button: accessible label + hover tooltip so a new user knows what it does (#508). */
  queueTooltip: "Queue this message to send in turn — it goes out after the agent finishes its current reply. (⌘↵)",
  /** Composer Steer button: accessible label + hover tooltip explaining how it differs from Send/Queue (#508). */
  steerTooltip: "Steer the running agent — jump this to the front of the line so it course-corrects next. (⌥↵)",
  /** Copy-to-clipboard controls (#657). */
  copy: {
    label: "Copy",
    done: "Copied.",
    failed: "Couldn't copy. Select the text and copy it manually.",
  },
  /** #509: heading above the clickable starter prompts shown in an empty channel. */
  startersHeading: "Not sure where to start? Tap one to drop it in the box:",
} as const;

/**
 * Live agent-theater copy (#624). The "watch the agents work" screen reads every string from here so the
 * view stays copy-free (house rule: brand voice via this module). Receipts-over-adjectives: it narrates
 * real reasoning → action → artifact, never a spinner.
 */
export const THEATER = {
  title: "The floor",
  subtitle: "Watch the team work — reasoning, action, and the artifacts they produce, live.",
  /** Header status labels, by connection state. */
  statusLive: "Live",
  statusConnecting: "Connecting…",
  statusReconnecting: "Reconnecting…",
  /** Lane status chips. */
  working: "Working",
  done: "Done",
  /** Nothing streaming yet. */
  empty: "No one's at work this second. Kick off an agent and you'll watch it think, act, and ship right here.",
  /** Per-phase label shown beside each streamed step. */
  phaseContext: "Context",
  phaseReasoning: "Thinking",
  phaseAction: "Action",
  phaseArtifact: "Artifact",
  phaseApproval: "Approval",
  /** Browser/computer-use live screen (#520). */
  browserRegion: "Live browser screen",
  browserTitle: "Agent screen",
  browserObserved: "observed",
  browserHeld: "needs your yes",
  browserNoUrl: "No page loaded yet",
  browserScreenshot: "Screenshot receipt captured",
  browserStatus: "HTTP",
  browserApproval: "Approval",
  browserNoApproval: "none",
  /** #516: cinematic current-step stage above the lanes. */
  heroRegion: "Live work theater",
  heroEyebrow: "Now on the floor",
  heroVerb: "is working on",
  heroEmpty: "Waiting for the first move.",
  currentStepRegion: "Current agent step",
  currentStep: "Current step",
  handoffLabel: "Handoff",
  heroStatus: "Stream",
  heroSteps: "Steps",
  /** Complete per-run trace affordance (#664). */
  openTrace: "Open trace",
  refreshTrace: "Refresh trace",
  traceLoading: "Loading full trace…",
  traceRegion: "Full run trace",
  traceEmpty: "No trace events recorded for this run yet.",
  traceLoadError: "Could not load the full trace.",
  /** Back-to-console link. */
  back: "← Back to console",
  /** Count line in the header: filled with live numbers. */
  agentsLabel: "agents",
  stepsLabel: "steps",
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
  dryRunTitle: "Publishing is in dry-run",
  dryRunBody:
    "Published pages will show dryrun.reload.app preview URLs, but they are not live until a real publishing provider is connected.",
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
  // A not-yet-live connector offers "notify me" instead of a dead stop (#507).
  waitlist: "Notify me when it's ready",
  waitlisted: "You're on the list — we'll let you know when it's ready.",
  blocked: "Setup required",
  connect: "Connect",
  connectedBadge: "Connected",
  proofPendingBadge: "Setup pending",
  proofPendingDetail: "Consent recorded. We'll show connected after the provider check passes.",
  unlocks: "Unlocks",
  lockedUntilConnected: "Locked until connected",
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
  // Recent outbound sends (#395 §3): the read-back proof that an approved send actually reached a real inbox.
  receiptsTitle: "Recent outbound sends",
  receiptsHint: "Every send your fleet made after you approved it — with the provider's delivery receipt.",
  receiptDelivered: "Delivered",
  receiptUnconfirmed: "Not confirmed",
  receiptTo: "To",
  receiptRef: "Provider reference",
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
    "Your department agents are working for you. Switch off any you don't want. " +
    "Spend always waits for your approval; outbound work follows the workspace policy you set.",
  loading: "Loading your agents…",
  empty: "No agents to show yet.",
  rollout: "The Agent Garden is rolling out for your workspace.",
  on: "On",
  off: "Off",
  preparing: "Getting ready",
  enable: "Switch on",
  disable: "Switch off",
  pending: "Awaiting your approval",
  needsApproval: "Needs your approval",
  capabilitiesLabel: "What they do",
  moneyGated: "needs your yes",
  moneyGatedTitle: "Tries to spend or send outside the building - so it waits for your yes.",
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
  { handle: "echo", name: "Echo", department: "social", personality: "Turns one good idea into a week of posts, then ships what policy allows with receipts." },
  { handle: "quill", name: "Quill", department: "content", personality: "Writes like a human on a good day — drafts that sound like you, faster." },
  { handle: "postmark", name: "Postmark", department: "email", personality: "Writes the emails people actually open. Never hits send — that's your call." },
  { handle: "bid", name: "Bid", department: "ads", personality: "Plans spend like it's their own money — which is to say, carefully." },
  { handle: "lens", name: "Lens", department: "analytics", personality: "Stares at the numbers so you don't have to, then names the one that matters." },
  { handle: "mark", name: "Mark", department: "brand", personality: "Keeps us sounding like us — warm, a little silly, never smug." },
  { handle: "comet", name: "Comet", department: "reach", personality: "Finds the people who just raised or just hired, and writes each one a single good line." },
];

/**
 * #509: per-channel starter prompts for an EMPTY channel. A blank "Quiet in here" tells a new user nothing
 * about what to ask in #ads vs #seo, so each department channel offers 2–3 concrete first actions — real
 * @-mention briefs that prefill the composer on tap (the user edits/sends, nothing fires on its own). Keyed
 * by department/channel name; channels without a department (e.g. #general, #launch) fall back to a generic
 * cross-fleet set so EVERY channel suggests something. User-facing copy only — no internal agent chatter.
 * The @handles are the named fleet leads (see {@link FLEET}), not brand strings.
 */
export const CHANNEL_STARTERS: Readonly<Record<string, readonly string[]>> = {
  seo: [
    "@scout audit our homepage for SEO quick wins",
    "@scout find the keywords we should be ranking for",
    "@scout check the site for broken links and crawl issues",
  ],
  social: [
    "@echo turn our latest update into a week of posts",
    "@echo draft a LinkedIn thread about what we do",
    "@echo what should we post this week?",
  ],
  content: [
    "@quill draft a blog post about our latest update",
    "@quill rewrite our homepage copy to sound more like us",
    "@quill outline a content calendar for next month",
  ],
  email: [
    "@postmark draft a welcome email for new signups",
    "@postmark write a launch announcement for our list",
    "@postmark suggest a re-engagement email for quiet subscribers",
  ],
  ads: [
    "@bid plan a starter ad campaign with a $20/day budget",
    "@bid draft three ad headlines for our main product",
    "@bid which audience should we target first?",
  ],
  analytics: [
    "@lens what's the one number we should watch this week?",
    "@lens summarise last week's traffic and conversions",
    "@lens where are we losing visitors on the site?",
  ],
  brand: [
    "@mark define our brand voice in a few lines",
    "@mark suggest taglines for our homepage",
    "@mark is this copy on-brand? (paste it in)",
  ],
  reach: [
    "@comet find companies that just raised and might need us",
    "@comet build a shortlist of outreach targets this week",
    "@comet draft a cold outreach opener for our best-fit customer",
  ],
};

/** Generic first actions for channels without a department (e.g. #general, #launch). */
export const DEFAULT_STARTERS: readonly string[] = [
  "@scout audit our homepage for SEO quick wins",
  "@quill draft a blog post about our latest update",
  "@lens what's the one number we should watch this week?",
];

/**
 * #509: the starter prompts to suggest in an empty channel, by channel name. A leading "#" is tolerated and
 * matching is case-insensitive; an unknown/blank name yields the generic {@link DEFAULT_STARTERS} set so
 * every channel suggests at least 2–3 concrete first actions.
 */
export function starterPromptsFor(channelName: string | null | undefined): readonly string[] {
  const key = channelName ? channelName.replace(/^#/, "").toLowerCase() : "";
  return CHANNEL_STARTERS[key] ?? DEFAULT_STARTERS;
}

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
  /** Outcome-first summary: what useful work this tier should produce every day. */
  readonly dailyValue: string;
  /** Plain-English limit that makes the upgrade ask predictable. */
  readonly dailyLimit: string;
  /** The buyer-facing reason to move up from this tier. */
  readonly upgradeTrigger: string;
  readonly featured: boolean;
  /** What you get — feature bullets, mirroring the server catalog so pricing reads from one truth. */
  readonly highlights: readonly string[];
}

interface FooterSocialLink {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

/**
 * Copy for the #260 one-screen onboarding (enter your domain → Sign in with Google). Centralised here so
 * the screen reads the brand. `errors` maps the `?error=<code>` the OAuth routes redirect with to a
 * house-voice line — every failure lands the user back on this screen, never a dead end.
 */
export const ONBOARDING = {
  title: "Type your domain. We'll get the room started.",
  sub: "Scout reads your site, the room drafts the first bit of work, and setup waits until you want to ship.",
  domainLabel: "Your website",
  domainPlaceholder: "acme.com",
  googleCta: "Connect Google to ship",
  reassurance: "No account needed for the first preview. Connect Google when you want receipts, Analytics, and Search Console.",
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
  fallbackSignup: {
    lead: "Google's having a little lie-down.",
    cta: "Create an account with email instead",
  },
  /** #300 low-commitment entry: the divider + link to the read-only sample workspace (no account needed). */
  sampleDivider: "Just want to look around?",
  sampleCta: "Explore a sample workspace",
  /**
   * #633 outcome-first onboarding: copy for the live deliverable that appears the moment a URL is typed —
   * config (the Google sign-in) runs alongside it, never as a gate.
   */
  deliverable: {
    /** Primary CTA on the entry screen — produces the artifact instead of demanding setup first. */
    cta: "Show me what you'd make for us",
    /** The "we're building it" status line shown while the first section streams in. */
    working: "Putting your deliverable together — this takes a few seconds, no setup needed…",
    /** Shown once the stream finishes. */
    ready: "That's a real sample of day-one work. Sign in and your agents do this for real.",
    /** The parallel-config nudge shown beside the streaming artifact (config is not a gate). */
    parallelTitle: "Like it? Make it yours.",
    parallelSub: "Sign in with Google while you read — your agents pick up right where this leaves off.",
    /** Let the visitor go back and try a different URL. */
    restart: "Try a different website",
    /** Honest failure copy if the stream can't start (offline / API down) — never a faked artifact. */
    error: "We couldn't build your preview just now. You can still sign in, or try again.",
    /** Per-kind labels for the section badges. */
    kinds: { insight: "Insight", action: "Action plan", draft: "Ready to use" },
  },
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
  consequence: "Sign in and Scout produces this for your site — money waits for your yes; allowed no-spend work ships with receipts.",
} as const;

/** Public approval/autonomy contract (#1180). Keep this as the source of truth for buyer-facing copy. */
export const APPROVAL_POLICY = {
  title: "Money waits. Allowed work moves.",
  money:
    "Charges, refunds, payouts, live payment keys, and paid ad spend always pause for an explicit approval.",
  external:
    "Non-money external work — publishing, deploys, social posts, and outreach — can run only through connected accounts and workspace policy. When allowed, it ships with an audit receipt, rollback/undo where the provider supports it, and the kill switch can stop new launches.",
  internal: "Drafts, research, audits, plans, and internal edits do not need approval; the fleet should keep moving.",
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
      "money waits for your yes; allowed no-spend work ships with receipts.",
    ctaPrimary: "Start",
    ctaSecondary: "Log in",
    ctaDemo: "Watch live demo",
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
    { n: "03", title: "You steer", body: "Money pauses for approval. Drafts, audits, and allowed no-spend actions keep moving with receipts." },
  ],
  sections: {
    howTitle: "How it works",
    howSub: "Three steps. No onboarding call, no Gantt chart.",
    fleetTitle: "Meet the department",
    fleetSub: "Eight specialists, one channel each, all on the same team.",
    pricingTitle: "See value first",
    pricingSub: "A useful daily marketing room, capped before spend gets silly.",
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
      tagline: "A daily checkup for one campaign.",
      dailyValue: "Site read, quick-win plan, and one draft your team can use.",
      dailyLimit: "1 active campaign, 5 agents, $200/mo work cap.",
      upgradeTrigger: "Upgrade when you want the agents to keep going after that first lane fills.",
      featured: false,
      highlights: ["Daily SEO/content/social check-ins", "5 agent seats for the default room", "$200/mo agent-work cap with receipts", "Approvals + audit trail included"],
    },
    {
      key: "pro",
      name: "Pro",
      price: "$199",
      tagline: "Your everyday growth room.",
      dailyValue: "SEO, content, outreach, and analytics agents working together.",
      dailyLimit: "3 active campaign lanes, 10 agents, $1,000/mo work cap.",
      upgradeTrigger: "Upgrade when you need more brands, clients, or parallel departments.",
      featured: true,
      highlights: ["Daily multi-agent growth standup", "10 agent seats across 3 lanes", "$1,000/mo agent-work cap with receipts", "Priority autonomy + deploy-to-live"],
    },
    {
      key: "agency",
      name: "Agency",
      price: "$499",
      tagline: "A full agency floor.",
      dailyValue: "Every day, multiple brands, launches, and client workstreams run in parallel.",
      dailyLimit: "10 active campaign lanes, 30 agents, $5,000/mo work cap.",
      upgradeTrigger: "Talk to us when you need custom controls, procurement, or a bigger cap.",
      featured: false,
      highlights: ["Daily cross-client mission control", "30 agent seats across 10 lanes", "$5,000/mo agent-work cap with receipts", "Everything in Pro, at scale"],
    },
  ] as readonly PlanTeaser[],
  /** Sticky in-page anchor nav (#165). Jump links to the page's own sections — the product's own chrome. */
  anchors: [
    { href: "#proof", label: "Proof" },
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
      { href: "/company", label: "Company" },
      { href: "/security", label: "Security & trust" },
      { href: "/refund-policy", label: "Refund policy" },
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
      { href: "/dpa", label: "DPA" },
    ],
    resourcesTitle: "Resources",
    resources: [
      { href: "/guides", label: "Guides" },
      { href: "/stories", label: "Stories" },
      { href: "/changelog", label: "Changelog" },
      { href: "/compare", label: "Compare" },
      { href: SUPPORT_CONTACT.href, label: SUPPORT_CONTACT.label },
    ],
    socialTitle: "Find us",
    /** No public profile links are rendered until real external accounts exist. */
    social: [] as readonly FooterSocialLink[],
  },
} as const;

/**
 * Production-readiness readout for the public pricing path and the owner dogfood surface (#1265/#1290/#1293).
 * It is intentionally plain about what is live, dogfood, demo, or blocked; a launch page that mixes those
 * buckets makes the product look better for a minute and less trustworthy forever.
 */
export const LAUNCH_READINESS = {
  eyebrow: "Launch readiness",
  title: "What is live, what is dogfood, and what still needs a real connector.",
  sub:
    "The product should show receipts instead of vibes. This readout separates real billing and agent work " +
    "from demo data, and names the operator lane that lets the owner use Codex without pretending a ChatGPT " +
    "subscription is a backend API key.",
  proofLabel: "Proof type",
  proof: [
    { label: "Live", body: "Real production code path with a receipt from the app, API, checkout, or connector." },
    { label: "Dogfood", body: "Work the fleet is doing for this product in the owner's workspace." },
    { label: "Demo", body: "Sample rows or scripted site visuals, clearly marked as non-customer proof." },
    { label: "Blocked", body: "Needs a connected provider, relay host, or owner approval before it can be called live." },
  ],
  pricing: {
    title: "Real pricing in the product",
    body:
      "The public plans match the billing catalog: Starter $49, Pro $199, Agency $499. Each plan carries " +
      "agent seats and a monthly session cap so upgrade moments can point at the exact value unlocked.",
    limits: [
      "Starter: 5 agent seats, $200 monthly session cap",
      "Pro: 10 agent seats, $1,000 monthly session cap",
      "Agency: 30 agent seats, $5,000 monthly session cap",
    ],
  },
  codex: {
    title: "Operator lane",
    status: "Dogfood handoff, not hidden credential use",
    body:
      "Agents can package implementation work for the owner's connected agent runtime and ingest the returned PR, " +
      "files, tests, and risks as an audited artifact. The production backend does not store or impersonate " +
      "the owner's model-provider session.",
  },
  checklistTitle: "Production checklist",
  checklist: [
    { area: "Auth and billing", state: "Live", detail: "Signup, plan intent, checkout return, and billing caps are visible in-app." },
    { area: "Marketing room", state: "Dogfood", detail: "The web coordination room shows departments, threads, DMs, and live session state." },
    { area: "Codex capacity", state: "Dogfood", detail: "Operator packets can hand build work to the owner's active Codex subscription." },
    { area: "Outbound OAuth", state: "Blocked", detail: "Google, social, and ads need live OAuth token exchange before they can be marked connected." },
    { area: "iMessage", state: "Blocked", detail: "Production needs a signed Mac relay host; Fly cannot run Apple Messages directly." },
    { area: "Customer proof", state: "Blocked", detail: "External proof requires a signup, payment, reply, booked call, or approval receipt." },
  ],
} as const;

/**
 * The dedicated public pricing page (#214). The landing teases pricing in-page (`BillingScreen`); this
 * is the focused, shareable, link-out destination an ad or a price-shopping visitor lands on — a clean
 * three-plan comparison with "what you get" bullets and one CTA per plan that carries the chosen plan
 * into signup + checkout (`/signup?plan=<key>&billing=<interval>`). The plans come from
 * {@link LANDING.plans} (one pricing truth), so this page adds no second copy of monthly prices. The
 * signup form then hands the chosen plan into hosted checkout instead of marooning the buyer in the app.
 */
export const PRICING = {
  eyebrow: "Plans & pricing",
  title: "See value first.",
  sub: "Start, watch the agents do useful daily work, then upgrade when you want more lanes running at once.",
  /** Accessible label for the plans grid region (distinct from the hero heading). */
  plansLabel: "Plans",
  perMonth: "/mo",
  perYear: "/yr",
  monthlyLabel: "Monthly",
  annualLabel: "Annual",
  annualBadge: "Two months free",
  /** The one recommended-tier ribbon. */
  popularBadge: "Most popular",
  /** Per-plan CTA — creates the account and opens hosted checkout for that tier. */
  planCta: "Keep them working",
  tableTitle: "Keep the agents working.",
  tableLede:
    "Start, see useful work every day, then upgrade when you want more campaigns, more agents, or more live work moving at once.",
  everyDayLabel: "Every day",
  limitLabel: "Limit:",
  upgradeLabel: "Upgrade:",
  currentPlanCta: "Your plan",
  pendingCheckoutCta: "Opening checkout…",
  tableFootnote:
    "everyday work is capped before spend gets silly. the agents are enthusiastic; billing is not.",
  /** Reassurance under the grid (honest: self-serve checkout, no sales call, you set the ceiling). */
  footnote:
    "Self-serve checkout takes card payment through Stripe after signup. Agent work is capped by plan, approvals stay visible, and we ask for the upgrade at the moment there is more useful work to do.",
  /** Pricing-specific questions, surfaced from the FAQ by question text (no copy duplicated). */
  faqMatch: [/cost/i, /free/i, /starter.*pro/i, /priority autonomy|deploy-to-live/i] as readonly RegExp[],
  faqTitle: "Pricing questions",
  /** Back to the full story. */
  backLabel: "← Back to the homepage",
  /** Signup trial framing (#214). `plan` is the chosen plan's display name. */
  trial: {
    eyebrow: "Free trial",
    onPlan: (plan: string): string => `You're choosing ${plan}. Tiny form first, useful agents next, checkout when you want more.`,
    generic: "Create the workspace, see the first useful work, then checkout opens when you want more.",
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
  workspaceName: "Acme — sample workspace",
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
      detail: "“Hire a whole marketing team of AI agents — money waits, work moves.” · 58 chars · Quill",
      requestedBy: "Quill",
      pendingLabel: "Waiting on you",
      approveLabel: "Approve",
      rejectLabel: "Send back",
      decidedLabel: "Approved by you",
      reply: "ship it ✅",
    },
    { kind: "message", time: "9:25", from: "postmark", dept: "email", text: "Queued the launch note to 3 lists (4,210 people). Workspace policy allows this send; receipt ready." },
    { kind: "message", time: "16:30", from: "lens", dept: "analytics", text: "End of day: /pricing impressions +18%, newsletter open rate +4.2%. Tidy work, team. 🎉", done: true },
  ] as readonly SimEntry[],
} as const;

/**
 * The two staged vignettes used as section visuals (#165): an approvals drawer that flips from pending to
 * approved (with the confetti micro-burst), and the #147 mission-control strip showing example sessions and
 * a running spend estimate against the cap. Pure illustrative sample data — NOT a live feed; the strings are
 * labelled "Sample" in the UI so a visitor is never told static copy is a real-time reading (de-theater
 * audit). The components animate the reveal only.
 */
export const APPROVALS_VIGNETTE = {
  title: "Approvals",
  subtitle: "Money waits for approval; policy-allowed work ships with receipts.",
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
  subtitle: "A sample of mission control — every agent, what it's doing, and what it's spending.",
  liveLabel: "Sample",
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
    title: "Money waits; allowed work moves",
    body:
      "Spend, charges, payouts, and payment keys always pause for a human. Non-money sends, publishing, " +
      "and deploys run only when your workspace policy allows them — with receipts, rollback where possible, and the kill switch close by.",
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

export interface PublicProofTile {
  readonly customer: string;
  readonly customerType: "dogfood" | "external";
  readonly metric: string;
  readonly result: string;
  readonly source: string;
  readonly href: string;
  readonly consented: boolean;
}

export interface StoryReceipt {
  readonly id: string;
  readonly customer: string;
  readonly customerType: "dogfood" | "external";
  readonly context: string;
  readonly problem: string;
  readonly work: string;
  readonly metric: string;
  readonly result: string;
  readonly receipt: string;
  readonly consentStatus: string;
  readonly date: string;
  readonly artifacts: readonly { label: string; href: string }[];
  readonly consented: boolean;
}

/** Source of truth for public proof: homepage tiles and /stories cards both read this list (#1178). */
export const STORY_RECEIPTS: readonly StoryReceipt[] = [
  {
    id: "ipop-dogfood-site",
    customer: "ipop.ai",
    customerType: "dogfood",
    context: "Internal dogfood launch for the public acquisition site",
    problem: "The product claimed autonomous marketing work, but the site lacked pricing, trust, FAQ, and receipt-backed proof.",
    work:
      "The fleet audited the funnel, drafted public pages, added pricing and support surfaces, then shipped changes through review and approval receipts.",
    metric: "Published dogfood story",
    result: "Site, pricing, FAQ, security, and proof scorecard shipped through the product workflow.",
    receipt: "Merged PRs and public route coverage in the agent-skills repo.",
    consentStatus: "Consented because this is ipop's own dogfood story.",
    date: "2026-06-25",
    artifacts: [
      { label: "Stories page", href: "/stories" },
      { label: "Pricing page", href: "/pricing" },
      { label: "Security page", href: "/security" },
    ],
    consented: true,
  },
  {
    id: "external-proof-pending",
    customer: "No external customer proof yet",
    customerType: "external",
    context: "External customer story slot",
    problem: "We have not published a consented third-party customer outcome yet.",
    work: "The next story needs a real customer context, approved metric, artifact trail, and safe public links.",
    metric: "External-customer outcome pending",
    result: "Appears only after a customer approves the outcome, metric, source, and artifacts for publication.",
    receipt: "No external receipt published yet.",
    consentStatus: "Awaiting explicit customer consent.",
    date: "Pending",
    artifacts: [],
    consented: false,
  },
];

/**
 * Public proof rail (#939). A tile may show a metric only when it is a real, consented outcome. External
 * customer slots render as guarded empty states until a customer approves publication.
 */
export const PUBLIC_PROOF = {
  id: "proof",
  eyebrow: "Proof",
  title: "Receipts before reach",
  sub:
    "The homepage has a public proof rail: dogfood is labelled as dogfood, external proof stays pending until a customer consents, and independent customer outcomes get their own receipts.",
  cta: "Read customer stories",
  emptyTitle: "External customer proof slot",
  emptyBody: "Appears here after a paying customer approves the outcome, metric, and source for publication.",
  consentLabel: "Consented outcome",
  pendingLabel: "Awaiting consent",
  ladderTitle: "What this proof is",
  ladder: [
    {
      label: "Internal dogfood",
      body: "ipop using ipop to build ipop. Useful, but not external customer proof.",
    },
    {
      label: "Consent-pending customer proof",
      body: "A real customer outcome can be tracked before publication, but appears publicly only after consent.",
    },
    {
      label: "Independently validated customer proof",
      body: "Published only with an approved metric, source, artifact trail, and customer permission.",
    },
  ],
  tiles: STORY_RECEIPTS.map((story) => ({
    customer: story.customer,
    customerType: story.customerType,
    metric: story.metric,
    result: story.result,
    source: story.receipt,
    href: "/stories",
    consented: story.consented,
  })) as readonly PublicProofTile[],
} as const;

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
    sub: "Connect Claude first, then hire your founding team — seven departments, each with a named lead — and hand them their first brief.",
    steps: [
      { k: "team", title: "Hire the team", body: "Seven departments — growth, product, design and the rest — each led by a named agent." },
      { k: "work", title: "They clock in", body: "Every lead opens their first task the moment they're hired. You'll watch the board fill up." },
      { k: "control", title: "You hold the keys", body: "Only money needs your yes — a charge, a payout, real spend. Everything else the fleet ships on its own, every step on the record." },
    ],
    cta: "Start your first venture",
    connectFirstCta: "Connect Claude first",
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
    connectHint: "Required before hiring: connect Claude in Settings so the team can actually run.",
    connectCta: "Open Settings",
    timeoutTitle: "Your team is ready, but Claude is not connected.",
    timeoutBody: "Nothing has appeared on the board yet. Connect Claude to start the work, or retry the hire flow.",
    timeoutRetry: "Retry hire",
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
  /** #521 workspace-home command center: one glance over live agents, spend, decisions, outcomes. */
  commandCenter: {
    region: "Mission-control command center",
    eyebrow: "Mission control",
    title: "The fleet, live",
    loading: "Loading fleet",
    idle: "Fleet idle",
    degraded: "Fleet warming up",
    live: (count: number): string => `${count} live`,
    none: "none",
    clear: "No fleet incidents asking for you.",
    noAgents: "No agents are running right now.",
    reliabilityTitle: "Reliability",
    reliabilityClear: "No recent failures",
    reliability: (rate: string, dominant: string): string => `${rate} failure rate · ${dominant}`,
    presenceRegion: "Agent presence field",
    agentsRegion: "Live agent statuses",
    reliabilityRegion: "Fleet reliability",
    metrics: {
      throughput: "Throughput",
      burn: "Burn",
      decisions: "Decisions",
      outcomes: "Outcomes",
    },
  },
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
  /** Persistent error toast (#658): never auto-dismisses; the owner gets details and an explicit close. */
  errorToast: {
    title: "Something needs attention",
    details: "Details",
    dismiss: "Dismiss error",
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
  /** Settings -> Policy control center (#1291): what can run, what queues, and the break-glass stop. */
  policy: {
    title: "Policy control center",
    eyebrow: "Governance",
    sub: "See what can run, what waits for you, what can be undone, and stop external work immediately.",
    breakGlassTitle: "Break-glass pause",
    breakGlassOn: "Autonomy paused",
    breakGlassOff: "Autonomy running",
    breakGlassBody:
      "This is the same workspace kill switch the fleet uses before launching new autonomous sessions. It stops queued external work without weakening the approval gate.",
    engage: "Pause external work",
    resume: "Resume autonomy",
    working: "Working...",
    pendingLabel: "Pending external approvals",
    loggedLabel: "Logged decisions",
    maintenanceLabel: "Maintenance",
    maintenanceOn: "read-only",
    maintenanceOff: "normal writes",
    simulatorTitle: "Dry-run simulator",
    simulatorSub: "Try any action against the current production policy posture.",
    simulate: "Run dry-run",
    outcomes: {
      auto: "auto-runs",
      approval: "queues for approval",
      blocked: "blocked",
    },
    rollbackTitle: "Rollback and undo status",
    policyRows: [
      {
        area: "Money",
        action: "Increase ad spend by $250",
        outcome: "approval",
        reason: "Money movement always waits for the owner before anything leaves.",
        rollback: "No post-hoc undo. Approval is the rollback boundary.",
      },
      {
        area: "Outbound",
        action: "Send a campaign reply",
        outcome: "approval",
        reason: "External sends are sensitive-by-default and route through the #13 queue.",
        rollback: "Can stop before send; after send the receipt is recorded.",
      },
      {
        area: "Publishing",
        action: "Promote a site change",
        outcome: "approval",
        reason: "Live publishing crosses a brand boundary and needs a receipt.",
        rollback: "Provider rollback/re-promote link required when available.",
      },
      {
        area: "Credentials",
        action: "Connect a provider token",
        outcome: "approval",
        reason: "Secrets are write-only and permissioned; money credentials still need owner approval.",
        rollback: "Disconnect/revoke removes the sealed credential proof.",
      },
      {
        area: "Data access",
        action: "Read connected analytics",
        outcome: "auto",
        reason: "Read-only analysis can run when the account is connected and scoped.",
        rollback: "No external mutation; audit receipt records the read.",
      },
    ],
  },
  /** First-run setup checklist (#479): the guided path from signup to first real output. */
  firstRunChecklist: {
    title: "Get set up",
    progress: (done: number, total: number): string => `${done} of ${total} done`,
    dismiss: "Hide",
    collapse: "Collapse",
    expand: "Expand",
    steps: {
      target: {
        label: "Tell us what to market",
        hint: "Goals, audience, positioning, and competitors so agents stop guessing.",
        cta: "Set target",
      },
      brand: { label: "Set your brand", hint: "Name, palette, and voice so the team sounds like you.", cta: "Set brand" },
      claude: { label: "Connect Claude", hint: "Required runtime access before the hired team can clock in.", cta: "Connect Claude" },
      connect: { label: "Connect an output account", hint: "Link one place your work goes out — the agents take it from there.", cta: "Connect" },
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
    /**
     * #510 workspace switcher: the top-left title is a real menu, not dead chrome. It lists the current
     * workspace/product (named by the #502 marketing target when set), plus shortcuts to point the fleet at
     * a new product and to open settings. `currentPrefix` labels the fallback when no product name is set.
     */
    switcher: {
      triggerLabel: "Switch workspace",
      heading: "Workspace",
      currentPrefix: "workspace",
      current: "Current",
      newProduct: "New product",
      settings: "Settings",
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
    /**
     * #503: the #487 runtime-failure banner is dismissible so it can't, stacked with the first-run card, push
     * the channel below the fold on load. The headline/detail are backend DATA; only the control label is copy.
     */
    diagnostic: {
      dismiss: "Dismiss",
      dismissLabel: "Dismiss the startup error",
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
    tabs: { general: "General", models: "Models", agents: "Agents", budget: "Budget", approvals: "Approvals", skillopt: "SkillOpt" },
    general: {
      repoLabel: "REPOSITORY",
      repoHint: "one project = one repo = one company",
      voiceLabel: "BRAND VOICE",
      voiceHint: "every agent here inherits this",
      voiceDefault: "Warm, a little silly, never smug. Receipts over adjectives.",
      appliedNow: "applied now",
    },
    models: {
      localLabel: "LOCAL · GEMMA",
      localHint: "voice + drafts on-device — nothing leaves this Mac",
      localConnected: "connected",
      keysHint: "keys are sealed per project, write-only — we use them, we can't read them back",
      noKey: "not connected",
      fingerprintPrefix: "saved ·",
      appliesNextRun: "applies next run",
      restartRequired: "restart required",
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
    skillopt: {
      title: "SkillOpt proposals",
      hint: "staged runbook edits with held-out validation receipts. adopt or reject through the same approval gate.",
      loading: "loading proposals...",
      empty: "no staged self-improvements yet.",
      verified: "external receipt verified",
      unverified: "not externally verified",
      adopt: "Adopt",
      reject: "Reject",
      working: "Working...",
      adoptReason: "Owner adopted the staged SkillOpt edit from the console.",
      rejectReason: "Owner rejected the staged SkillOpt edit from the console.",
      error: "Couldn't load SkillOpt proposals.",
      decisionError: "Couldn't update that SkillOpt approval.",
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
 * Everyday workspace shell (#784) — every word of the redesigned, chat-first "everyday shell" lives here so
 * the component stays copy-free (house rule: brand voice via this module). The voice is Innocent Drinks
 * dialed CHEEKY: lowercase, warm, a bit of attitude, legible and kind, never mean. Personality lives in the
 * small places — empty states, nudges, buttons, celebrations. The structure mirrors the surface: a north
 * star up top (customers + revenue), a calm thread where deliverables and previews land inline, an approval
 * queue that is a one-glance ship decision, a quiet transparency log of external actions, and a money +
 * kill-switch line framed as reassurance, not config.
 */
export const EVERYDAY = {
  /** Time-of-day greeting (editorial serif headline). `name` is the signed-in human's first name. */
  greeting(name: string, partOfDay: "morning" | "afternoon" | "evening"): string {
    const who = name.trim() || "you";
    return `${partOfDay}, ${who.toLowerCase()}. right then — what are we making pop today?`;
  },
  /** The single ever-present prompt under the greeting. */
  prompt: "what are we marketing today?",
  /** Composer placeholder — the one input that starts everything. */
  composerPlaceholder: "give us a product, a url, or just a vibe…",
  composerSend: "off you pop",

  /** The visible cowork room: multiple agents working together, with an operator lane. */
  room: {
    heading: "iMessage room",
    subhead: "your marketing team, texting the work as it happens.",
    empty: "type a domain or goal and we'll wake the room up.",
    chatLabel: "text your ipop team",
    codexBadge: "team engine active",
    imessageNotes: {
      ready: "Messages loop proven. Your team can text receipts, replies, approvals, and agent updates through iMessage.",
      replyNeeded: "Messages can send the room. Reply once from iMessage and we'll mark the full loop proven.",
      relayBlocked: "Messages is not live yet. The web room stays honest until the Mac relay proves send and reply access.",
      setupNeeded: "Add your iMessage destination to move this room from web-only to Messages.",
    },
    statuses: {
      idle: "waiting",
      working: "working",
      blocked: "blocked",
      done: "done",
      codex: "operator handoff",
    },
  },

  /**
   * Owner-visible Codex operator packet (#1265): a handoff preview/copy affordance, not a backend runtime
   * credential claim.
   */
  codexLane: {
    title: "Operator lane",
    packetTitle: "Operator packet",
    packetBody: "The exact handoff the operator agent will receive for this room.",
    openPacket: "Open packet",
    copyPacket: "Copy packet",
  },

  /** Tomo-style first-run connectors: visible, grouped, and honest about what is connected. */
  connectors: {
    heading: "Room visibility",
    subhead: "web room today, external chat bridges only when verified. no fake green ticks.",
    connect: "connect",
    connected: "connected",
    pending: "verify",
    connecting: "connecting…",
    connectError: "that didn't connect. try again in a moment.",
    outcome: {
      redirecting: "opening the secure connect screen…",
      connected: "connected.",
      pending: "consent recorded — finishing setup…",
      waitlisted: "not live yet — we'll email you the moment it opens.",
      imessage: "add your iMessage address above to finish setup.",
    },
    publicAction: "open workspace",
    publicHint: "connectors need your workspace before they can run.",
    imessage: {
      title: "Text the team",
      body:
        "Add the iMessage address or phone number where the team should send receipts. We'll send one test first, then the room can start.",
      label: "iMessage email or phone",
      placeholder: "you@example.com or +15551234567",
      serviceLabel: "Messages service",
      servicePlaceholder: "iMessage",
      save: "save",
      test: "send test",
      disconnect: "remove",
      verified: "verified",
      loopPending: "reply needed",
      blocked: "relay not live",
      pending: "test needed",
      notSet: "not connected",
      readyDetail: "agent-room relay has sent receipts and received an iMessage reply back into the room.",
      loopPendingDetail: "relay can send the room starter; reply from Messages once to prove the full loop.",
      blockedDetail: "recipient is verified, but the Messages relay is not live yet.",
      pendingDetail: "saved, but not used until a test send works.",
      emptyDetail: "no personal iMessage destination yet.",
      saved: "Saved. Send the test before starting the room.",
      tested: "Test sent. The room can use this destination now.",
      removed: "Removed.",
      error: "That didn't pop. Check the address and try again.",
    },
    groups: {
      productivity: "productivity",
      visibility: "visibility",
      marketing: "marketing",
      publishing: "publishing",
    },
  },

  /** North star (customers + revenue front and centre, #630). Labels only — numbers come from data. */
  northStar: {
    eyebrow: "the only scoreboard that matters",
    customersLabel: "paying customers",
    revenueLabel: "revenue",
    deltaUp: "up and to the right, just how we like it.",
    deltaFlat: "holding steady. let's go nudge it.",
    zero: "no customers yet. that's not a problem, that's the whole point of us.",
  },

  /** One-icon dashboard from the homepage: concise summary of agent work done. */
  dashboard: {
    heading: "Marketing dashboard",
    subhead: "what changed, what needs review, which channels are connected, and what happens next.",
    sample: "sample readout",
    live: "live workspace",
    readiness: "setup checklist",
    executive: "today at a glance",
    rankedWork: "work that matters",
    goalTarget: "target",
    pace: "pace",
    capacity: "plan limits",
    funnel: "customer journey",
    since: "since last check-in",
    channels: "where customers can come from",
    blockers: "needs setup",
    decisions: "needs your call",
    next: "next best actions",
    latest: "proof + receipts",
    empty: "nothing measurable yet. text the team and this fills itself in.",
    source: "source",
    status: "status",
    pipeline: "progress",
    conversion: "conversion",
    spend: "spend",
    move: "next move",
  },

  /** Calm thread where work lands inline. */
  thread: {
    heading: "today",
    /** Empty state — bit quiet in here. */
    empty: "bit quiet in here. give us a product and we'll cause a scene.",
    /** A nudge when the fleet is idle and waiting on a brief. */
    nudge: "we've got a whole department twiddling its thumbs. point us at something?",
    /** An agent is mid-task (in-thread status). `agent` is the agent's name. */
    working(agent: string): string {
      return `${agent.toLowerCase()} is nosing through your site. we won't judge. much.`;
    },
    /** Agent landed something good. */
    resultGood: "on it. ok, this one's good.",
    /** Agent self-corrects. */
    resultRedo: "yeah, that was rubbish. take two.",
    /** Label above an inline deliverable preview/diff that landed in the thread. */
    previewLabel: "here's what we made",
    /** Label above a before/after diff preview. */
    diffLabel: "before → after",
    /** Customer-safe replacement for accidental raw tool/shell activity in the room. */
    internalToolActivity: "checking the workspace. we'll post the useful bit here, not the plumbing.",
  },

  /** Approval queue = one-glance ship decisions showing the finished deliverable (#572/#574/#632). */
  approvals: {
    heading: "your call",
    /** Sits under the heading — one human, one glance, one decision. */
    subhead: "the finished thing, not the faff. give it a look and tell us to send it.",
    /** Empty queue. */
    empty: "nothing waiting on you. go get a coffee — we've got this.",
    /** The two buttons (cheeky, decisive). */
    ship: "ship it",
    redo: "nah, redo",
    redoSend: "send back",
    redoNote: "what should change?",
    redoPlaceholder: "make it warmer, shorter, or less salesy...",
    redoDefaultNote: "Please revise this deliverable.",
    pending: "sending this decision to the approval gate...",
    decisionError: "couldn't record that decision. try again.",
    /** Per-card: what actually happens on approve (consequence line). */
    consequencePrefix: "approve and we'll",
    /** The deliverable-card eyebrow so it's clear this is the real artifact, not chatter. */
    deliverableEyebrow: "finished deliverable",
  },

  /** Quiet transparency log: every external action, timestamped + linked (#629). */
  transparency: {
    heading: "what we did out there",
    subhead: "every move we made in the real world. timestamped, linked, no surprises.",
    empty: "we haven't touched the outside world yet. when we do, it all shows up here.",
    /** Accessible label for the timestamp column. */
    whenLabel: "when",
    /** Search box label for filtering the append-only external action log. */
    searchLabel: "search outside-world actions",
    /** Search box placeholder. */
    searchPlaceholder: "search actions",
    /** Empty filtered state. */
    noResults: "nothing matches that search.",
    /** Status suffix shown after a public action has been undone. */
    undone: "undone",
    /** Link text to the external artifact. */
    viewLink: "see it",
  },

  /** Money gate + kill-switch, framed as reassurance not config. The hard gate is money; the rest is calm. */
  safety: {
    /** Money gate — shown on any spend/send before it goes out. */
    moneyGate: "this one costs actual money. your call, big spender.",
    moneyGateApprove: "yep, spend it",
    moneyGateHold: "hold off",
    /** The kill-switch line: always on, framed as a hand on the wheel, not a setting. */
    killSwitchTitle: "your hand's on the wheel",
    killSwitchBody:
      "nothing leaves the building or spends a penny without your nod. one tap stops the whole fleet, " +
      "any time. it's always on — you don't have to do a thing.",
    killSwitchAction: "stop everything",
    killSwitchConfirm: "tap once more and the agents stop taking new work.",
    killSwitchCancel: "not now",
    killSwitchPending: "stopping the fleet...",
    killSwitchEngaged: "all agents stopped. nothing new starts until you resume them.",
    killSwitchResume: "resume agents",
    killSwitchResumePending: "resuming the fleet...",
    killSwitchError: "couldn't update the fleet switch. please try again.",
    /** Reassurance footer eyebrow. */
    eyebrow: "the boring-but-important bit",
  },

  /** Celebrations — subtle delight on ship, a real party on the first paying customer. */
  celebrate: {
    shipped: "sent. that's a real thing in the real world now. nice one.",
    firstCustomer: "oi. someone just PAID you. go scream into a pillow.",
    /** Smaller wins. */
    milestone: "another one ships. the robots are earning their keep.",
  },

  /** Connect prompt (Cowork-style single Allow), reused if a deliverable needs a tool. `tool` is the name. */
  connect(tool: string): string {
    return `lend us your ${tool.toLowerCase()} for a sec? best behaviour, promise.`;
  },
  connectAllow: "go on then",
} as const;

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
  subheading: "Start with everyday value. Upgrade when you want more lanes moving.",
  currentLabel: "Current plan",
  selectLabel: "Choose",
  perMonth: "/mo",
  /** Which plan renders as the currently-active subscription in the chrome. */
  currentPlan: "Pro",
  /** A couple of true-to-product line items under the plan cards. */
  footnote: "Everyday agent work is billed against your cap. You set the ceiling; we never cross it.",
  /**
   * The real, in-app Settings → Billing panel (not the landing mockup): current plan, this-window usage vs
   * cap, and a clearly-marked test-mode note. Reused by {@link BillingSettings}.
   */
  panel: {
    eyebrow: "Plan & billing",
    blurb: "See today's value, this-window usage, and the upgrade path when you want more agents moving.",
    currentPlanLabel: "Current plan",
    trialPlan: "Free trial",
    usageLabel: "Usage this window",
    capSuffix: "cap",
    noCap: "no cap set",
    seatsSuffix: "seats",
    valueTitle: "Work left this month",
    valueReadyTitle: "Room to keep working",
    valueReadyBody: (remaining: string, cap: string): string =>
      `${remaining} of ${cap} remains before the agents pause for the month.`,
    valueNearCapTitle: "Nearly at the line",
    valueNearCapBody: (remaining: string, cap: string): string =>
      `${remaining} remains from ${cap}. Time to upgrade before good work starts waiting.`,
    valuePausedTitle: "Agents paused at the cap",
    valuePausedBody: (cap: string): string =>
      `This workspace has used its ${cap} agent-work cap. Upgrade to open more room.`,
    valueNoCapTitle: "No monthly work cap set",
    valueNoCapBody: "Set a plan cap before letting the agents run unattended.",
    dailyValueLabel: "Everyday value",
    dailyLimitLabel: "Plan limit",
    productLimitsLabel: "Included quota",
    liveQuotasLabel: "Live quota usage",
    activeCampaignLanesLabel: "Campaign lanes",
    connectedChannelsLabel: "Connected channels",
    dailyOutreachSendsLabel: "Daily sends",
    approvalQueueSizeLabel: "Approval queue",
    dashboardHistoryDaysLabel: "History",
    upgradeTriggerLabel: "Upgrade moment",
    /** Clearly-marked safety note: live charges stay off until the owner connects Stripe. */
    testModeTitle: "Test mode — no live charges yet",
    testModeBody:
      "Checkout is wired end-to-end but runs in test mode. Going live (connecting Stripe and taking the first real payment) is the owner's call — until then nothing is charged.",
    /** Shown instead of the test-mode note once the owner has flipped go-live (#481): real money is on. */
    liveModeTitle: "Live — real payments are on",
    liveModeBody:
      "Checkout is live: real cards are charged and your plan activates the moment payment clears. Invoices and receipts appear here after payment.",
    invoicesTitle: "Invoices & receipts",
    noInvoices: "No invoices yet. Paid invoices and PDFs appear here after checkout.",
    invoiceLinkLabel: "Open invoice",
    invoicePdfLabel: "Open PDF",
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
      a: `${APPROVAL_POLICY.money} ${APPROVAL_POLICY.external} ${APPROVAL_POLICY.internal}`,
    },
    {
      q: "What can the agents actually do?",
      a: "SEO audits, content drafts, social calendars, email campaigns, ad planning, analytics digests, brand-voice checks, and outbound prospecting. They research, write, plan, publish, deploy, and send only through connected accounts and the workspace policy you set. They do not pretend to be human, and every external action leaves a receipt.",
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
      q: "What does it cost, and what's the difference between Starter and Pro?",
      a: "Start, no card. Starter is $49/month for a daily checkup on one campaign: site read, quick-win plan, one usable draft, five agent seats, a $200 monthly work cap, approvals, and the audit trail. Pro is $199/month for the everyday growth room: ten seats, a $1,000 monthly work cap, three campaign lanes, priority autonomy, and deploy-to-live. Upgrade when the first lane is working and you want more departments moving without waiting in line.",
    },
    {
      q: "What is the refund policy and support SLA?",
      a: "Paid customers can request a refund within 14 days of the first charge if the fleet cannot deliver the promised starter work after support has had a fair chance to help. We acknowledge support requests within one business day, and urgent billing or access issues are prioritized first.",
    },
    {
      q: "What do priority autonomy and deploy-to-live mean?",
      a: "Priority autonomy means Pro work gets a larger budget and earlier background-run capacity, so agents can keep planning, drafting, and checking without you restarting every step. Deploy-to-live means approved site or venture changes can move from preview to the live customer URL through the product flow, with receipts and rollback paths instead of a manual handoff.",
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
  trialLinkLabel: "Send me a trial link",
  trialCta: "Start a free trial",
  trialHref: "/start?source=landing_contact_cta",
  bookingCta: "Start the first-customer sprint",
  bookingHref: "/start?source=landing_booking_cta",
  nextStepIntro: "Want to keep moving now?",
  /** In-flight label while the lead is posting. */
  sendingLabel: "Sending…",
  /** Shown after the lead is captured (GAP 1, ADR-0400) — it now really persists + reaches a human. */
  sentNote: "Got it — your note's in. A person will read it and reply, usually within a day.",
  /** Shown if the post fails — honest, with a fallback so the lead is never silently lost. */
  errorNote: `That didn't go through. Mind trying again, or email us at ${SUPPORT_CONTACT.email} and we'll pick it up.`,
  consentLabel: "I agree to be contacted about ipop and accept the public legal terms, privacy notice, and DPA.",
  consentHelp:
    "We use this to reply to your note, keep a consent record, and honor privacy or data-subject-rights requests sent to support@ipop.ai.",
} as const;

/** Public company-level legal pages (#863). Factual product terms, not per-venture generated docs. */
export const LEGAL = {
  terms: {
    eyebrow: "Terms of Service",
    title: "Terms for using ipop",
    sub:
      "These are the public platform terms for creating an account, running agents, approving work, and paying for ipop.",
    navLabel: "Terms",
    href: "/terms",
    updated: "Updated June 25, 2026",
    sections: [
      {
        title: "What ipop provides",
        body:
          "ipop gives your workspace AI-agent tools for marketing operations, research, drafting, analytics, and approved publishing. You are responsible for the goals, inputs, accounts, and approvals you provide.",
      },
      {
        title: "Accounts and acceptable use",
        body:
          "Keep account details accurate, protect credentials, and do not use the service for unlawful, abusive, deceptive, spam, malware, or rights-infringing activity. We may restrict access when safety, security, or legal risk requires it.",
      },
      {
        title: "Approvals, spend, and third-party services",
        body:
          "Money movement and external publishing require the product's approval gates where configured. Third-party platforms, ad networks, payment processors, and model providers may apply their own terms and fees.",
      },
      {
        title: "Customer content and outputs",
        body:
          "You keep ownership of content you provide. Outputs are generated from your instructions and connected tools; review them before relying on them, publishing them, or using them in regulated contexts.",
      },
      {
        title: "Billing, refunds, and support",
        body:
          "Paid plans, budget caps, refunds, and support response targets are described before checkout and on the refund policy page. Approved third-party spend may not be refundable.",
      },
      {
        title: "Changes and contact",
        body:
          "We may update these terms as the product changes. Material changes will be reflected on this page. Questions go to support@ipop.ai.",
      },
    ],
  },
  privacy: {
    eyebrow: "Privacy Policy",
    title: "How ipop handles personal data",
    sub:
      "This policy explains what we collect from visitors and customers, why we use it, and how to contact us about privacy requests.",
    navLabel: "Privacy",
    href: "/privacy",
    updated: "Updated June 25, 2026",
    sections: [
      {
        title: "Data we collect",
        body:
          "We collect account details such as name, email, workspace slug, authentication events, contact-form messages, support requests, billing metadata, connected-tool status, and product usage needed to run the service.",
      },
      {
        title: "How we use it",
        body:
          "We use data to create accounts, operate workspaces, respond to messages, provide support, secure the service, measure product health, process billing, and improve agent workflows.",
      },
      {
        title: "Connected tools and processors",
        body:
          "When you connect external tools, ipop uses the granted access to perform requested work. Payment, hosting, analytics, email, and model providers process data for us under their own processor terms.",
      },
      {
        title: "Marketing contact and consent",
        body:
          "Contact and signup forms ask for consent before we store and use your details to reply. You can opt out of marketing or request deletion by contacting support@ipop.ai.",
      },
      {
        title: "Security and retention",
        body:
          "We use workspace isolation, scoped credentials, approval gates, and audit logs. We keep personal data only as long as needed for the service, legal obligations, security, and customer support.",
      },
      {
        title: "Your choices",
        body:
          "You can request access, correction, deletion, export, or restriction of personal data by emailing support@ipop.ai. We may need to verify the request before acting on it.",
      },
    ],
  },
  dpa: {
    eyebrow: "Data Processing Agreement",
    title: "DPA for customer data",
    sub:
      "This DPA explains how ipop processes customer personal data, supports GDPR Article 28 obligations, and handles data-subject requests.",
    navLabel: "DPA",
    href: "/dpa",
    updated: "Updated June 25, 2026",
    sections: [
      {
        title: "Roles and scope",
        body:
          "When ipop processes personal data on behalf of a customer to provide the service, the customer acts as controller or business and ipop acts as processor or service provider.",
      },
      {
        title: "Processing instructions",
        body:
          "We process customer personal data only to provide, secure, support, and improve the service; follow documented customer instructions; and comply with applicable law.",
      },
      {
        title: "Security measures",
        body:
          "The service uses workspace isolation, scoped credentials, approval gates, audit logs, and reasonable technical and organizational safeguards appropriate to the data processed.",
      },
      {
        title: "Subprocessors",
        body:
          "We may use hosting, payment, analytics, email, and model providers as subprocessors where needed to run ipop. We remain responsible for subprocessors we engage for the service.",
      },
      {
        title: "Data-subject rights",
        body:
          "Customers and data subjects can request access, export, deletion, correction, objection, or restriction by emailing support@ipop.ai. We may verify requests before acting.",
      },
      {
        title: "Return, deletion, and transfers",
        body:
          "On termination or verified request, we delete or return personal data unless retention is required for legal, security, billing, or audit obligations. Where transfer mechanisms are required, the parties use an appropriate lawful mechanism.",
      },
    ],
  },
  backCta: "Back home",
  securityCta: "Security & trust",
  consentVersion: "public-legal-dpa-2026-06-25",
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
  slaTitle: "Support SLA",
  sla:
    "We acknowledge customer support requests within one business day. Billing, access, and live-work blockers are prioritized first, and every support case keeps an auditable status instead of disappearing into email.",
  /** NOT built / NOT certified. Each carries an explicit status so it can never be read as a claim. */
  roadmapTitle: "On the roadmap — not yet",
  roadmap: [
    { title: "SOC 2 Type II", status: "Planned — not yet certified", body: "We're building toward an audit. We are not certified today and don't claim to be." },
    { title: "SSO / SAML", status: "Designed seam — not yet built", body: "The wiring point exists in the code; no identity provider is connected yet." },
    { title: "Kernel-level network policy", status: "Partial — application-enforced today", body: "Egress is enforced at the application layer now; in-sandbox kernel enforcement is the next step." },
  ],
  readinessTitle: "Production readiness, without the fog machine",
  readiness:
    "If you are putting real marketing work through ipop, these are the controls to inspect before trusting autonomy.",
  readinessItems: [
    {
      title: "External proof lane",
      body:
        "Dogfood receipts, consent-pending customer outcomes, and independently validated customer proof are tracked separately. If a customer has not approved publication, the public surface says so instead of borrowing the metric.",
    },
    {
      title: "Policy setup and dry-runs",
      body:
        "Workspace policy is configured through approval policies and scoped connection settings. Teams should test a proposed policy in dry-run before enabling live sends, spend, publishing, or deploys.",
    },
    {
      title: "Readable decisions and rollback",
      body:
        "Allowed, blocked, failed, and rolled-back actions need receipts a human can read: who requested it, which policy matched, what changed, what evidence came back, and what rollback path exists.",
    },
    {
      title: "Setup and permission docs",
      body:
        "Production onboarding needs the integration, permission, credential, rollback, and failure-mode docs in front of the buyer before they hand agents live accounts.",
    },
  ],
  notClaimedTitle: "What we don't claim",
  notClaimed:
    "We hold no third-party security certifications today. This page describes mechanisms we built, not audits we passed. When that changes, this page will say so — with a date.",
  backCta: "Back to home",
  /** The footer/nav link label that points visitors at this page. */
  navLabel: "Security & trust",
} as const;

/** Public support and refund terms (#865). Kept factual: it describes the current money gate and support SLA. */
export const REFUND_POLICY = {
  eyebrow: "Refunds & support",
  title: "Plain terms before you pay",
  sub:
    "No mystery policy hidden after checkout. Here is how refunds, billing support, and response times work for paid ipop customers.",
  sections: [
    {
      title: "14-day first-charge refund window",
      body:
        "If your first paid workspace cannot deliver the promised starter work, contact support within 14 days of the charge. We will either help unblock the fleet or process a refund through the money-approval path.",
    },
    {
      title: "Human-reviewed money actions",
      body:
        "Refunds are never fired automatically by an agent. They are recorded, reviewed, and approved by a human with the amount visible before money moves.",
    },
    {
      title: "Support SLA",
      body:
        "We acknowledge customer support requests within one business day. Billing, access, and live-work blockers are prioritized first.",
    },
    {
      title: "What is not refundable",
      body:
        "Approved third-party spend, completed custom services, abuse, fraud, and repeated policy violations are not refundable. We will still provide receipts and a clear explanation.",
    },
  ],
  cta: "Back to pricing",
  ctaHref: "/pricing",
  securityCta: "Security & trust",
  securityHref: "/security",
  navLabel: "Refund policy",
} as const;

function companyValue(key: string, fallback: string): string {
  const value = (env as unknown as Record<string, string | undefined>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** Public company information (#866): buyer/procurement basics, with env-overridable details. */
export const COMPANY = {
  eyebrow: "Company",
  title: "Company information",
  sub:
    "The factual details a buyer, payment processor, or legal team needs before contracts, invoices, and payouts.",
  navLabel: "Company",
  href: "/company",
  updated: "Updated June 25, 2026",
  factsTitle: "Business details",
  details: [
    {
      label: "Legal entity status",
      value: companyValue(
        "VITE_COMPANY_LEGAL_ENTITY",
        "Gagan Arora, owner/operator of ipop.ai. Procurement receives the current legal and tax details before signature.",
      ),
    },
    {
      label: "Jurisdiction",
      value: companyValue(
        "VITE_COMPANY_JURISDICTION",
        "United States operating status; registered-office details are shared in the procurement packet before signature.",
      ),
    },
    {
      label: "Postal notices",
      value: companyValue(
        "VITE_COMPANY_POSTAL_ADDRESS",
        "No public registered office is listed yet. Send notice requests to support@ipop.ai so the team can provide the correct notice path before contract signature.",
      ),
    },
    {
      label: "Principal contact",
      value: companyValue("VITE_COMPANY_PRINCIPAL", "Gagan Arora, owner; procurement routes through support@ipop.ai."),
    },
    {
      label: "Tax and vendor forms",
      value:
        "W-9, tax, and vendor onboarding forms are not published for anonymous download. Request the current packet at support@ipop.ai.",
    },
  ],
  sections: [
    {
      title: "Procurement packet",
      body:
        "For vendor onboarding, ask for the buyer packet: contracting entity confirmation, tax form status, security questionnaire, subprocessors, DPA, terms, privacy, refund policy, and support/SLA notes.",
    },
    {
      title: "Security and subprocessors",
      body:
        "The public security page describes shipped controls and roadmap items; the DPA and privacy policy cover processor/subprocessor handling. If a current subprocessor list is needed for review, request it with the procurement packet.",
    },
    {
      title: "Public legal documents",
      body:
        "Terms, privacy, DPA, refund policy, security, and support details are linked below so buyers can review baseline operating terms before talking to the team.",
    },
  ],
  legalLinks: [
    { href: LEGAL.terms.href, label: LEGAL.terms.navLabel },
    { href: LEGAL.privacy.href, label: LEGAL.privacy.navLabel },
    { href: LEGAL.dpa.href, label: LEGAL.dpa.navLabel },
    { href: "/security", label: SECURITY.navLabel },
    { href: "/refund-policy", label: REFUND_POLICY.navLabel },
    { href: SUPPORT_CONTACT.href, label: SUPPORT_CONTACT.label },
  ],
  backCta: "Back home",
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
  ctaPrimary: "Start",
  ctaSecondary: "Log in",
  /** The dogfood credit on every content page — the agents drafted it, a human approved it. */
  maintainedBy: "This page is maintained by Quill, our content agent — drafted by AI, approved by a human.",
  support: SUPPORT_CONTACT,
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
  prompt: "Explain ipop.ai to me — the marketing team in your messages. What is it, who is it for, and what's the catch?",
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
  sub: "Real setups, real numbers. First up: how our own fleet built and runs this very site. External proof is marked plainly until a customer approves it.",
  proof: STORY_RECEIPTS,
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

export interface SegmentLandingPage {
  readonly slug: string;
  readonly path: string;
  readonly navLabel: string;
  readonly seoTitleSubject: string;
  readonly seoDescription: string;
  readonly hero: {
    readonly eyebrow: string;
    readonly title: string;
    readonly sub: string;
  };
  readonly proof: {
    readonly title: string;
    readonly body: string;
    readonly metric: string;
  };
  readonly bullets: readonly string[];
  readonly cta: {
    readonly label: string;
    readonly href: string;
  };
  readonly experiment: {
    readonly id: string;
    readonly variants: readonly { readonly key: "a" | "b"; readonly label: string; readonly href: string }[];
  };
}

/** #599: approved ICP-specific landing pages generated from campaign briefs and kept behind this fact gate. */
export const SEGMENT_LANDING_PAGES = [
  {
    slug: "startups",
    path: "/segments/startups",
    navLabel: "Startups",
    seoTitleSubject: "AI marketing team for startups",
    seoDescription:
      "A startup landing page for founders who need strategy, content, launch assets, and weekly proof without hiring a full marketing team.",
    hero: {
      eyebrow: "For founder-led startups",
      title: "Ship the marketing team before you can hire one",
      sub:
        "ipop turns a launch brief into positioning, content, landing-page updates, and approval-ready outreach while the founder keeps final say.",
    },
    proof: {
      title: "Built for the week after the roadmap changed",
      body:
        "The fleet keeps copy, experiments, and founder updates moving in parallel, then brings spend and outbound back to the approval queue.",
      metric: "3 launch surfaces from one brief",
    },
    bullets: [
      "Turn one product brief into ICP pages, launch posts, and founder updates.",
      "Keep approvals human for spend, publishing, and outbound sends.",
      "Use the same workspace to inspect every draft, revision, and shipped artifact.",
    ],
    cta: { label: "Start the startup brief", href: "/start?segment=startups" },
    experiment: {
      id: "segment-startups-hero",
      variants: [
        { key: "a", label: "Outcome-first headline", href: "/segments/startups?ab=a" },
        { key: "b", label: "Team-before-hiring headline", href: "/segments/startups?ab=b" },
      ],
    },
  },
  {
    slug: "agencies",
    path: "/segments/agencies",
    navLabel: "Agencies",
    seoTitleSubject: "AI marketing agents for agencies",
    seoDescription:
      "A segment landing page for agencies that need overflow research, drafts, QA, and client-ready marketing assets without adding headcount.",
    hero: {
      eyebrow: "For lean agencies",
      title: "Give every account team a back office that ships",
      sub:
        "ipop drafts research, content, briefs, and QA notes so strategists spend less time chasing blank pages and more time steering quality.",
    },
    proof: {
      title: "Overflow work without mystery labor",
      body:
        "Every deliverable stays visible in the decision queue, with receipts for who drafted it and what still needs client approval.",
      metric: "Review-ready drafts before standup",
    },
    bullets: [
      "Spin up account-specific research, content, and campaign drafts from one client brief.",
      "Keep client-sensitive approvals inside the queue before anything leaves the workspace.",
      "Standardize QA so every strategist sees the same proof, sources, and next action.",
    ],
    cta: { label: "Build an agency pod", href: "/start?segment=agencies" },
    experiment: {
      id: "segment-agencies-hero",
      variants: [
        { key: "a", label: "Back-office headline", href: "/segments/agencies?ab=a" },
        { key: "b", label: "Overflow headline", href: "/segments/agencies?ab=b" },
      ],
    },
  },
  {
    slug: "solo-operators",
    path: "/segments/solo-operators",
    navLabel: "Solo operators",
    seoTitleSubject: "AI marketing department for solo operators",
    seoDescription:
      "A segment landing page for solo operators who need a small AI marketing department to turn offers into proof, pages, and follow-up.",
    hero: {
      eyebrow: "For one-person teams",
      title: "A tiny department for the work you keep postponing",
      sub:
        "ipop turns the offer in your head into pages, posts, follow-up drafts, and proof checks without pretending you suddenly have spare time.",
    },
    proof: {
      title: "Small enough to steer, useful enough to trust",
      body:
        "You get one place to brief, review, and approve the work, with clear gates before publishing, spending, or sending anything externally.",
      metric: "One brief, one queue, many finished drafts",
    },
    bullets: [
      "Convert a messy offer into page copy, proof points, and follow-up drafts.",
      "See what is done, what needs your yes, and what should wait.",
      "Keep the system honest: no fake customers, no silent sending, no mystery spend.",
    ],
    cta: { label: "Start the solo brief", href: "/start?segment=solo-operators" },
    experiment: {
      id: "segment-solo-operators-hero",
      variants: [
        { key: "a", label: "Tiny-department headline", href: "/segments/solo-operators?ab=a" },
        { key: "b", label: "Postponed-work headline", href: "/segments/solo-operators?ab=b" },
      ],
    },
  },
] as const satisfies readonly SegmentLandingPage[];

export function segmentLandingPage(slug: string | undefined): SegmentLandingPage | undefined {
  return SEGMENT_LANDING_PAGES.find((page) => page.slug === slug);
}

/**
 * Per-route SEO metadata for the prerendered public surfaces (#467). Scout's audit found every route —
 * home, login, start, pricing, the marketing sections — shared the homepage's `<title>`, description, and
 * H1, and that the real subject was buried after ~18 words of build-config boilerplate. Each entry here is
 * a UNIQUE, FRONT-LOADED `<title>` (the distinguishing term first, the brand trailing) plus a focused meta
 * description. The prerender step (`entry-server.tsx` → `injectPage`) bakes these into the static `<head>`
 * for each page, so a raw crawl gets the right title/description/canonical instead of the homepage's.
 *
 * The home page keeps its hand-written tags in `index.html`; this map covers every other public route.
 * Descriptions reuse each page's own on-page subtitle so there is one source of truth for the copy.
 * Keyed by canonical path. `name` is the human label used for the breadcrumb trail.
 */
export const PAGE_SEO = {
  "/start": {
    name: "Start",
    title: `Start your AI marketing team — ${BRAND.name}`,
    description:
      "Open the live Telegram room and text your AI marketing team what to market next.",
  },
  "/welcome": {
    name: "Welcome",
    title: `Welcome — build with your AI marketing team`,
    description:
      "Choose Telegram from the public door and start the AI marketing team where you already message.",
  },
  "/demo": {
    name: "Live demo",
    title: `Live demo — see ${BRAND.name} build your marketing deliverable`,
    description:
      "Drop in your website and watch a real, personalized growth deliverable build itself before you create an account.",
  },
  "/sandbox": {
    name: "Sandbox",
    title: `Sandbox — try the ${BRAND.name} marketing deliverable builder`,
    description:
      "Use the no-signup sandbox to preview the marketing deliverable ipop can build from your website.",
  },
  "/login": {
    name: "Sign in",
    title: `Sign in — ${BRAND.name} workspace`,
    description: "Sign in to your ipop workspace and keep your autonomous marketing team moving.",
  },
  "/signup": {
    name: "Sign up",
    title: `Sign up — start ${BRAND.name} without a card`,
    description: PRICING.trial.generic,
  },
  "/everyday": {
    name: "Everyday workspace",
    title: `Everyday workspace — sign in to steer ${BRAND.name}`,
    description:
      "The everyday workspace is where signed-in teams review approvals, receipts, and the work queue before anything risky ships.",
  },
  "/dashboard": {
    name: "Dashboard",
    title: `Dashboard — sign in to review ${BRAND.name} work`,
    description:
      "The dashboard opens signed-in teams into live ipop work receipts, workspace state, and agent coordination instead of a dead static link.",
  },
  "/theater": {
    name: "Agent theater",
    title: `Agent theater — sign in to watch ${BRAND.name} work live`,
    description:
      "The live agent theater shows workspace-scoped reasoning, actions, artifacts, and receipts once you sign in.",
  },
  "/support/status": {
    name: "Support ticket status",
    title: `Support ticket status — ${BRAND.name}`,
    description:
      "Open a ticket status link to see its current state, SLA target, response status, and timeline.",
  },
  "/status/test": {
    name: "Status page",
    title: `Status page — ${BRAND.name} public component health`,
    description:
      "A public workspace status route shows published component health and incident history when the workspace has opted in.",
  },
  "/pricing": {
    name: "Pricing",
    title: `Pricing — ${BRAND.name}, your marketing agency of AI agents`,
    description: PRICING.sub,
  },
  "/refund-policy": {
    name: "Refund policy",
    title: `Refund policy — ${BRAND.name} support SLA and billing terms`,
    description: REFUND_POLICY.sub,
  },
  "/security": {
    name: SECURITY.navLabel,
    title: `Security & trust — ${BRAND.name} shipped controls and roadmap`,
    description: SECURITY.sub,
  },
  "/terms": {
    name: "Terms",
    title: `Terms of Service — ${BRAND.name} platform terms`,
    description: LEGAL.terms.sub,
  },
  "/privacy": {
    name: "Privacy",
    title: `Privacy Policy — how ${BRAND.name} handles customer data`,
    description: LEGAL.privacy.sub,
  },
  "/company": {
    name: COMPANY.navLabel,
    title: `Company information — ${BRAND.name} legal and operator details`,
    description: COMPANY.sub,
  },
  "/dpa": {
    name: "DPA",
    title: `DPA / Data Processing Agreement — ${BRAND.name} customer data terms`,
    description: LEGAL.dpa.sub,
  },
  "/compare": {
    name: "Compare",
    title: `Compare ${BRAND.name} vs. the alternatives`,
    description: COMPARE.sub,
  },
  "/stories": {
    name: "Customer stories",
    title: `Customer stories — ${BRAND.name} receipts, not testimonials`,
    description: STORIES.sub,
  },
  "/guides": {
    name: "Guides",
    title: "Guides — how AI marketing agents actually work",
    description: GUIDES.sub,
  },
  "/changelog": {
    name: "Changelog",
    title: `Changelog — what the ${BRAND.name} fleet shipped`,
    description: CHANGELOG.sub,
  },
  "/brand": {
    name: "Brand kit",
    title: `Brand kit — the ${BRAND.name} marks, palette & voice`,
    description: BRAND_ASSETS.sub,
  },
} as const satisfies Record<string, { name: string; title: string; description: string }>;

/** Copy for the soft paywall nudge (#153 trial funnel). Honest: surfaces the real plan + the real cap. */
export const PAYWALL = {
  title: "that's today's free work used up",
  body:
    "You've seen the useful bit: the audit, the plan, and drafts. We're politely not spending past your cap; " +
    "upgrade when you want the agents to keep going across more campaigns.",
  cta: "keep them working",
  dismiss: "not now",
  /** Shown as the small print under the nudge, naming the current plan. */
  onPlan: (planName: string): string => `currently on ${planName}. capped on purpose.`,
} as const;
