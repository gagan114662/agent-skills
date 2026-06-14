/**
 * First-run activation (console v5). A fresh workspace has no projects and a dead 0/0/0 board — the
 * moment we either earn the owner or lose them. Rather than a void, this guided panel walks them to their
 * first running project in under a minute: one clear CTA that hires the founding team through the REAL
 * #123/#138 department seed (the same seam #187's venture-factory bootstrap uses), then lets the board's
 * own polls fill in as each lead opens its first task. Nothing faked; every word comes from `brand.ts`.
 *
 * Two states: the pitch (steps + CTA) and, once the seed lands, the "clocking in" confirmation with a
 * gentle nudge to connect Claude so the team can actually run. Motion-free, so it's reduced-motion safe.
 *
 * When the seed fails (#221) the panel is honest about why and offers a real next step rather than a dead
 * retry: a 429 rate-limit shows a countdown and holds the CTA until the server's `Retry-After` elapses; a
 * missing runtime routes to Settings → Connect Claude; anything else falls back to a plain retry line.
 */
import { CONSOLE, consoleSeedRetryNote } from "../../brand.js";
import { PopMark } from "../PopMark.js";

/** Why the seed didn't produce a running venture (#221) — drives the panel's actionable failure copy. */
export type SeedError =
  /** Rate-limited (429): hold the retry for `retryAfterSeconds`, then let them try again. */
  | { kind: "rate"; retryAfterSeconds: number }
  /** No Claude runtime connected: the team can't run until the owner connects one (→ Settings). */
  | { kind: "connect" }
  /** Anything else: a plain, quiet retry line. */
  | { kind: "generic" };

export interface ConsoleEmptyStateProps {
  /** Stand up the founding team (the #123/#138 seed). */
  onStart: () => void;
  /** The seed is in flight — the CTA shows its busy label and disables. */
  busy: boolean;
  /** The seed landed — show the "clocking in" confirmation instead of the pitch. */
  seeded: boolean;
  /** The seed call failed — surface the matching actionable message by the CTA (null = no error). */
  error: SeedError | null;
  /**
   * Seconds left on the authoritative rate-limit hold (#227), owned by the parent so the same countdown
   * governs every seed affordance. While > 0 (with a `rate` error) the CTA is hard-held — it cannot re-fire.
   */
  coolOff: number;
  /** Open workspace settings (where Claude/Slack connect lives). */
  onConnect: () => void;
}

export function ConsoleEmptyState({
  onStart,
  busy,
  seeded,
  error,
  coolOff,
  onConnect,
}: ConsoleEmptyStateProps): React.JSX.Element {
  const copy = CONSOLE.firstRun;

  if (seeded) {
    return (
      <div className="firstrun" role="status">
        <PopMark className="firstrun__mark" />
        <p className="firstrun__assembling">{copy.assembling}</p>
        <p className="firstrun__hint">
          {copy.connectHint}{" "}
          <button className="firstrun__link" onClick={onConnect}>
            {copy.connectCta}
          </button>
        </p>
      </div>
    );
  }

  const held = error?.kind === "rate" && coolOff > 0;
  const ctaLabel = busy ? copy.ctaBusy : held ? copy.retryWait : copy.cta;

  return (
    <div className="firstrun">
      <PopMark className="firstrun__mark" />
      <span className="firstrun__eyebrow">{copy.eyebrow}</span>
      <h2 className="firstrun__headline">{copy.headline}</h2>
      <p className="firstrun__sub">{copy.sub}</p>

      <ol className="firstrun__steps">
        {copy.steps.map((step, i) => (
          <li key={step.k} className="firstrun__step">
            <span className="firstrun__num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="firstrun__steptext">
              <span className="firstrun__steptitle">{step.title}</span>
              <span className="firstrun__stepbody">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>

      <button className="btn btn--primary firstrun__cta" onClick={onStart} disabled={busy || held}>
        {ctaLabel}
      </button>

      {/* #221: an honest, actionable failure line — never a retry that just re-hits the same wall. */}
      {error?.kind === "rate" && (
        <p className="firstrun__err" role="status">
          {coolOff > 0 ? consoleSeedRetryNote(coolOff) : copy.retryNow}
        </p>
      )}
      {error?.kind === "connect" && (
        <p className="firstrun__err">
          {copy.connectError}{" "}
          <button className="firstrun__link" onClick={onConnect}>
            {copy.connectErrorCta}
          </button>
        </p>
      )}
      {error?.kind === "generic" && <p className="firstrun__err">{copy.ctaError}</p>}

      <p className="firstrun__hint">
        {copy.connectHint}{" "}
        <button className="firstrun__link" onClick={onConnect}>
          {copy.connectCta}
        </button>
      </p>
    </div>
  );
}
