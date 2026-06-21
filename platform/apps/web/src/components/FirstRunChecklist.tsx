/**
 * First-run setup checklist (#479) — presentational. Shows the four-step path from signup to first real
 * output (set brand → connect an account → run an agent → see & approve the result), each ticked off from
 * REAL signals (see lib/firstrun-checklist.ts). A done step shows a check and drops its call-to-action; an
 * outstanding step shows its CTA, which the parent routes to the right surface. The whole card hides once
 * every step is real, or when the user dismisses it.
 *
 * #505: the card docks. It is collapsible — when `collapsed`, only its compact one-line header bar renders
 * (title · progress · controls) and the tall steps list is hidden, so the checklist never takes over the
 * message area; Hide removes it entirely. Both states persist per user (see ConsoleView + lib/firstrun-prefs).
 *
 * Copy lives in brand.ts CONSOLE.firstRun (house rule: no hardcoded brand strings in product chrome).
 */
import { CONSOLE } from "../brand.js";
import type { FirstRunStep, FirstRunStepKey } from "../lib/firstrun-checklist.js";
import { firstRunProgress } from "../lib/firstrun-checklist.js";

export interface FirstRunChecklistProps {
  steps: FirstRunStep[];
  /** Docked to its compact header bar — the steps list is hidden so it doesn't cover the message area. */
  collapsed: boolean;
  /** Route an outstanding step's CTA to its surface (open settings, the approvals inbox, etc.). */
  onAction: (key: FirstRunStepKey) => void;
  /** Toggle the docked/expanded state (persisted per user by the parent). */
  onToggleCollapse: () => void;
  /** Dismiss the checklist for good (persisted per user by the parent). */
  onDismiss: () => void;
}

export function FirstRunChecklist({
  steps,
  collapsed,
  onAction,
  onToggleCollapse,
  onDismiss,
}: FirstRunChecklistProps): React.JSX.Element {
  const { done, total } = firstRunProgress(steps);
  const copy = CONSOLE.firstRunChecklist;

  return (
    <section className={`firstrun${collapsed ? " firstrun--collapsed" : ""}`} aria-label={copy.title}>
      <header className="firstrun__head">
        <button
          type="button"
          className="firstrun__toggle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? copy.expand : copy.collapse}
          title={collapsed ? copy.expand : copy.collapse}
        >
          <span className="firstrun__chevron" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
        <h2 className="firstrun__title">{copy.title}</h2>
        <span className="firstrun__progress">{copy.progress(done, total)}</span>
        <button type="button" className="firstrun__dismiss" onClick={onDismiss}>
          {copy.dismiss}
        </button>
      </header>
      {!collapsed && (
        <ol className="firstrun__steps">
          {steps.map((s, i) => {
            const step = copy.steps[s.key];
            return (
              <li key={s.key} className={`firstrun__step${s.done ? " firstrun__step--done" : ""}`}>
                <span className="firstrun__mark" aria-hidden="true">
                  {s.done ? "✓" : i + 1}
                </span>
                <span className="firstrun__body">
                  <span className="firstrun__label">{step.label}</span>
                  <span className="firstrun__hint">{step.hint}</span>
                </span>
                {s.done ? (
                  <span className="firstrun__check" aria-label="done">
                    ✓
                  </span>
                ) : (
                  <button type="button" className="firstrun__cta btn btn--small" onClick={() => onAction(s.key)}>
                    {step.cta}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
