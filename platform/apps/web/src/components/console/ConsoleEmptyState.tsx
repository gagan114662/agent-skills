/**
 * First-run activation (console v5). A fresh workspace has no projects and a dead 0/0/0 board — the
 * moment we either earn the owner or lose them. Rather than a void, this guided panel walks them to their
 * first running project in under a minute: one clear CTA that hires the founding team through the REAL
 * #123/#138 department seed (the same seam #187's venture-factory bootstrap uses), then lets the board's
 * own polls fill in as each lead opens its first task. Nothing faked; every word comes from `brand.ts`.
 *
 * Two states: the pitch (steps + CTA) and, once the seed lands, the "clocking in" confirmation with a
 * gentle nudge to connect Claude so the team can actually run. Motion-free, so it's reduced-motion safe.
 */
import { CONSOLE } from "../../brand.js";
import { PopMark } from "../PopMark.js";

export interface ConsoleEmptyStateProps {
  /** Stand up the founding team (the #123/#138 seed). */
  onStart: () => void;
  /** The seed is in flight — the CTA shows its busy label and disables. */
  busy: boolean;
  /** The seed landed — show the "clocking in" confirmation instead of the pitch. */
  seeded: boolean;
  /** The seed call failed — surface a quiet retry line by the CTA. */
  error: boolean;
  /** Open workspace settings (where Claude/Slack connect lives). */
  onConnect: () => void;
}

export function ConsoleEmptyState({
  onStart,
  busy,
  seeded,
  error,
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

      <button className="btn btn--primary firstrun__cta" onClick={onStart} disabled={busy}>
        {busy ? copy.ctaBusy : copy.cta}
      </button>
      {error && <p className="firstrun__err">{copy.ctaError}</p>}
      <p className="firstrun__hint">
        {copy.connectHint}{" "}
        <button className="firstrun__link" onClick={onConnect}>
          {copy.connectCta}
        </button>
      </p>
    </div>
  );
}
