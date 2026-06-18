/**
 * Deploy-freshness banner (#366) — presentational.
 *
 * Makes the "stale Vercel bundle vs newer api.ipop.ai" (and preview-vs-prod) confusion this epic kept
 * hitting VISIBLE instead of silent. The parent fetches the API's `/version` (#292) and compares it against
 * this bundle's build stamp (VITE_RELOAD_BUILD_SHA) via the pure {@link decideVersionParity}; this component
 * only renders the result.
 *
 * Pure + fail-quiet: it shows ONLY for a confirmed `mismatch` (two valid, divergent SHAs). `match`,
 * `unknown` (an unstamped local build or an unreachable/old API), and `null` (still loading) all render
 * nothing — so it never flashes a wrong/false-alarm state, and prod with no env (the gate is off) never
 * mounts it at all. Gated default-OFF + owner-workspace-first by `version-check.ts`.
 */
import { CONSOLE } from "../../brand.js";
import type { VersionParityVerdict } from "./version-check.js";

export interface VersionMismatchBannerProps {
  /** The parity verdict, or null while the API `/version` is still loading. */
  verdict: VersionParityVerdict | null;
  /** Hard reload to pull the freshest bundle. Injectable so the render is unit-tested without `window`. */
  onReload?: () => void;
}

export function VersionMismatchBanner({
  verdict,
  onReload,
}: VersionMismatchBannerProps): React.JSX.Element | null {
  // Only a CONFIRMED mismatch surfaces. Loading / match / unknown stay silent — never a false alarm.
  if (!verdict || verdict.status !== "mismatch") return null;
  const copy = CONSOLE.versionCheck;
  const reload = onReload ?? (() => typeof window !== "undefined" && window.location.reload());

  return (
    <div className="versionmismatch" role="alert" aria-label={copy.label}>
      <i aria-hidden="true" />
      <span className="versionmismatch__text">
        <strong>{copy.title}</strong> — {copy.body}
        {/* The two short SHAs are bounded hex (normalizeSha), safe to render as plain text. */}
        {verdict.web && verdict.api && (
          <span className="versionmismatch__shas">
            {" "}
            web {verdict.web.slice(0, 7)} · API {verdict.api.slice(0, 7)}
          </span>
        )}
      </span>
      <button type="button" className="versionmismatch__reload" onClick={reload}>
        {copy.refresh}
      </button>
    </div>
  );
}
