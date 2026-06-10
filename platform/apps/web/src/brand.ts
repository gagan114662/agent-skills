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
  mark: env.VITE_BRAND_MARK ?? "◆",
  title: env.VITE_BRAND_TITLE ?? "ipop — your marketing agency of AI agents",
  tagline: env.VITE_BRAND_TAGLINE ?? "The marketing agency of AI agents — you steer, they ship.",
  accent: env.VITE_BRAND_ACCENT ?? "#5b8cff",
};

/**
 * Applies brand-driven values that live outside React: the document title and the `--accent`
 * CSS custom property. Called once from `main.tsx` at boot. No-op fields keep the static
 * stylesheet defaults when the env vars are unset.
 */
export function applyBrand(brand: Brand = BRAND, doc: Document = document): void {
  doc.title = brand.title;
  doc.documentElement.style.setProperty("--accent", brand.accent);
}
