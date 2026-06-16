/**
 * Domain normalisation for the #260 onboarding screen — the single text field a non-technical user fills
 * in before "Sign in with Google". They might type `acme.com`, `https://www.Acme.com/`, ` ACME.com `, or
 * paste a full URL; we reduce all of those to one canonical bare host + an `https://` site URL + a slug
 * for the workspace. Pure + dependency-free so it is trivially unit-tested and reused by the route.
 */

export type DomainResult =
  | { ok: true; domain: string; url: string; slug: string }
  | { ok: false; reason: string };

/** A pragmatic hostname check: one-or-more dot-separated labels + a 2+ char alpha TLD. No IPs, no ports. */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Normalise a user-typed domain to `{ domain, url, slug }`, or an error reason. Strips scheme, path,
 * query, port, a leading `www.`, and surrounding whitespace; lowercases; validates the result is a
 * plausible hostname. The slug is the host with dots → hyphens, safe for `workspaces.slug`.
 */
export function normalizeDomain(input: string): DomainResult {
  let raw = (input ?? "").trim().toLowerCase();
  if (raw.length === 0) return { ok: false, reason: "enter your website domain" };

  // Drop a scheme if present, then anything from the first slash / query / port onward.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  raw = raw.split(/[/?#]/)[0]!;
  raw = raw.split(":")[0]!;
  // A bare "www." prefix is noise — the apex is what Search Console / sitemaps key on.
  raw = raw.replace(/^www\./, "");

  if (raw.length === 0) return { ok: false, reason: "enter your website domain" };
  if (!HOST_RE.test(raw)) {
    return { ok: false, reason: "that doesn't look like a domain — try something like acme.com" };
  }

  const slug = raw.replace(/\./g, "-").replace(/[^a-z0-9-]/g, "");
  return { ok: true, domain: raw, url: `https://${raw}`, slug };
}
