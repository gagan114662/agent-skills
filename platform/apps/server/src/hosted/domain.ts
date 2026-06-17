/**
 * #266 — the PURE public-URL resolver for a hosted site. A customer's pages are reachable EITHER on the
 * customer's own domain (once verified through the #264 DNS automation) OR on a free ipop subdomain
 * (`<subdomain>.sites.ipop.app`) the moment they sign up — zero DNS required. No IO; the caller passes the
 * stored site record.
 *
 * The slug is the security boundary: `resolveHostedUrl` REFUSES to build a URL for an invalid slug rather
 * than emit one with a `..`/path-traversal payload in it (defense in depth — `decideHostedPublish` already
 * validated, but a URL builder must never trust its input).
 */

import { isValidHostedSlug } from "./decide.js";

/** The base host for free ipop subdomains. A site with no verified custom domain lives at `<sub>.<base>`. */
export const IPOP_HOSTED_BASE_HOST = "sites.ipop.app";

/** Subdomains and custom domains share the DNS label charset (no uppercase, no `..`, no path). */
const DNS_LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAIN_RE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\.)+[a-z]{2,}$/;

export function isValidSubdomain(value: string): boolean {
  return value.length > 0 && value.length <= 63 && DNS_LABEL_RE.test(value);
}

export function isValidCustomDomain(value: string): boolean {
  return value.length > 0 && value.length <= 253 && DOMAIN_RE.test(value.toLowerCase());
}

/** The minimal site shape the URL resolver needs (a slice of the stored `hosted_sites` row). */
export interface HostedSiteAddress {
  subdomain: string;
  customDomain?: string | null;
  /** Only a VERIFIED custom domain (#264 DNS flow proved control) is served; an unverified one is ignored. */
  domainVerified?: boolean | null;
}

export interface ResolveHostedUrlOptions {
  /** Override the ipop base host (config-driven; defaults to {@link IPOP_HOSTED_BASE_HOST}). */
  baseHost?: string;
}

/**
 * The host a site is served on: its verified custom domain if it has one, else its ipop subdomain. Pure +
 * total — falls back to the subdomain whenever the custom domain is missing or unverified.
 */
export function resolveHostedHost(site: HostedSiteAddress, opts: ResolveHostedUrlOptions = {}): string {
  const base = opts.baseHost ?? IPOP_HOSTED_BASE_HOST;
  const custom = site.customDomain?.trim().toLowerCase();
  if (custom && site.domainVerified === true && isValidCustomDomain(custom)) return custom;
  return `${site.subdomain}.${base}`;
}

/**
 * The canonical public URL for `(site, slug)`. THROWS on an invalid slug — a URL builder must never emit a
 * path it cannot vouch for (premortem #200 §6). `https://<host>/<slug>`.
 */
export function resolveHostedUrl(
  site: HostedSiteAddress,
  slug: string,
  opts: ResolveHostedUrlOptions = {},
): string {
  if (!isValidHostedSlug(slug)) {
    throw new Error(`refusing to build a hosted URL for an unsafe slug: ${JSON.stringify(slug)}`);
  }
  return `https://${resolveHostedHost(site, opts)}/${slug}`;
}
