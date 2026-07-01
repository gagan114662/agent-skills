/**
 * "Built with ipop" tracked badge — Engine 1 of the compounding-distribution loop (#399, ADR-0399).
 *
 * Every artifact the fleet ships (a published page, a PR'd blog post, a rendered deliverable) becomes a
 * billboard back to ipop.ai: a small "Built with ipop" footer linking to a TRACKED url. The link carries the
 * #386 tracking ref ({@link ./tracking.mintTrackingRef}) + UTM provenance, so an inbound click is
 * attributable to the exact artifact that produced it — the same causal chain the attributed-revenue ledger
 * (#386, ADR-0386) measures. Each shipped artifact is therefore a self-distributing, measurable seed.
 *
 * Pure: no IO, no clock, no randomness. The ref is a deterministic function of (workspace, artifact, channel),
 * so the same artifact always carries the same badge — re-rendering is idempotent.
 *
 * Trust note (#200): the badge is ipop's own fixed-voice content ("Built with ipop"); the URL is our OWN
 * minted tracking ref pointed at our OWN domain — no untrusted artifact text flows into the link or the label.
 */

import { mintTrackingRef, buildTrackedUrl, type Utm } from "./tracking.js";
import { DEFAULT_PUBLIC_APP_ORIGIN } from "../product-origins.js";

export type BadgeFormat = "html" | "markdown" | "text";

export interface BuildAttributionBadgeInput {
  workspaceId: string;
  /** The fleet artifact the click is attributed back to (content file path, page slug, or PR title). */
  artifactId: string;
  /** The exposure channel the artifact ships through (e.g. "site_pr", "publish", "seo"). */
  channel: string;
  format: BadgeFormat;
  /** Override the link target (defaults to ipop.ai). */
  baseUrl?: string;
  /** Override the UTM source (defaults to "builtwith"). */
  utmSource?: string;
}

/** The fixed, human-readable label — ipop's own voice, never artifact-derived. */
const BADGE_LABEL = "Built with ipop";
const DEFAULT_BASE_URL = DEFAULT_PUBLIC_APP_ORIGIN;
const DEFAULT_UTM_SOURCE = "builtwith";

/**
 * Encode a string for safe interpolation into an HTML attribute / text node. The URL is our own minted ref,
 * but we still encode it so the snippet is well-formed and can never break out of the `href` quoting.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a "Built with ipop" snippet in the requested format. Mints the #386 tracking ref + a tracked url to
 * `baseUrl ?? https://ipop.ai` with utm {source: utmSource ?? "builtwith", medium: "badge", campaign: channel}.
 */
export function buildAttributionBadge(input: BuildAttributionBadgeInput): string {
  const ref = mintTrackingRef({
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    channel: input.channel,
  });
  const utm: Utm = {
    source: input.utmSource ?? DEFAULT_UTM_SOURCE,
    medium: "badge",
    campaign: input.channel,
  };
  const url = buildTrackedUrl(input.baseUrl ?? DEFAULT_BASE_URL, ref, utm);

  switch (input.format) {
    case "html":
      return (
        `<footer class="builtwith-ipop">` +
        `<a href="${escapeHtml(url)}" rel="noopener" target="_blank">${BADGE_LABEL}</a>` +
        `</footer>`
      );
    case "markdown":
      return `[${BADGE_LABEL}](${url})`;
    case "text":
      return `${BADGE_LABEL}: ${url}`;
  }
}

/**
 * Append a badge to existing artifact content with the separator appropriate to the format:
 *  - markdown / text: a trailing blank line then the badge.
 *  - html: inserted immediately before the closing `</body>` if present, else appended at the end.
 *
 * Pure string surgery — never parses or mutates the artifact body otherwise.
 */
export function appendBadge(content: string, badge: string, format: BadgeFormat): string {
  if (format === "html") {
    const idx = content.toLowerCase().lastIndexOf("</body>");
    if (idx !== -1) {
      return content.slice(0, idx) + badge + content.slice(idx);
    }
    return content + badge;
  }
  // markdown / text: separate the badge from the body with a blank line.
  return `${content}\n\n${badge}`;
}

/** Pick the badge format for a repo content file from its path/extension (`.md` → markdown, `.html` → html). */
export function badgeFormatForPath(path: string): BadgeFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return "text";
}
