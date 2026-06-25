/**
 * Marketing-site route matching (#153). Kept tiny and dependency-free so `AuthGate` can import it
 * eagerly (it must decide *synchronously* whether a path belongs to the lazy marketing bundle, before
 * the phase checks). The pages themselves live in the code-split `MarketingSite` chunk.
 */

/** The content sections served as `/compare`, `/stories`, `/guides`, `/changelog`. */
export const MARKETING_SECTIONS = ["compare", "stories", "guides", "changelog"] as const;
export type MarketingSection = (typeof MARKETING_SECTIONS)[number];

/** Every top-level marketing path prefix (sections + the brand page + segment landing pages). */
const PREFIXES = [...MARKETING_SECTIONS, "brand", "segments"] as const;

/** True when `path` is a public marketing-site route (an index or a `/section/slug` document). */
export function isMarketingPath(path: string): boolean {
  const seg = path.replace(/^\/+/, "").split("/")[0] ?? "";
  return (PREFIXES as readonly string[]).includes(seg);
}

/** Parse a marketing path into `{ section, slug }`. `slug` is undefined for a section index. */
export function parseMarketingPath(path: string): { section: string; slug?: string } {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  return { section: parts[0] ?? "", ...(parts[1] ? { slug: parts[1] } : {}) };
}
