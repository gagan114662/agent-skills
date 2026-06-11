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
 * Applies brand-driven values that live outside React: the document title and the `--accent`
 * CSS custom property. Called once from `main.tsx` at boot. No-op fields keep the static
 * stylesheet defaults when the env vars are unset.
 */
export function applyBrand(brand: Brand = BRAND, doc: Document = document): void {
  doc.title = brand.title;
  doc.documentElement.style.setProperty("--accent", brand.accent);
}
