/**
 * Analytics tag snippet — the pure tag builder (issue #270).
 *
 * Builds the `<script>`/snippet ipop injects so the owner never writes a line of tag code. The snippet is
 * derived purely from the read provider + the measurement id; it is opaque, no-network, side-effect-free to
 * produce. {@link analyticsSnippetFingerprint} is a stable, content-only fingerprint of the snippet that the
 * install record stores as proof of WHAT was installed (so a later provider/id change is detectable and the
 * tag is re-installed idempotently — never duplicated).
 */

import { createHash } from "node:crypto";

import type { AnalyticsInstallMethod } from "./decide.js";

/** Build the analytics snippet to inject for a provider + measurement id. Empty id ⇒ a no-op placeholder. */
export function analyticsTagSnippet(provider: string, measurementId: string): string {
  const id = measurementId.trim();
  if (id === "") {
    // No id configured yet: a documented placeholder, never a live tag that points at nothing.
    return `<!-- ipop analytics (${provider}): pending measurement id -->`;
  }
  switch (provider) {
    case "ga4":
      return (
        `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
        `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
        `gtag('js',new Date());gtag('config','${id}');</script>`
      );
    case "plausible":
      return `<script defer data-domain="${id}" src="https://plausible.io/js/script.js"></script>`;
    default:
      // `dryrun` and any unknown provider get a recorded-only placeholder — the install is logged but no
      // live analytics vendor is contacted (premortem #200 §2: no fabricated "we're tracking" claim).
      return `<!-- ipop analytics (${provider}) dry-run tag for ${id} -->`;
  }
}

/** A stable content-only fingerprint of an installed snippet (method-qualified), for idempotent re-install. */
export function analyticsSnippetFingerprint(method: AnalyticsInstallMethod, snippet: string): string {
  return createHash("sha256").update(`${method}\n${snippet}`).digest("hex").slice(0, 16);
}
