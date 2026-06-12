/**
 * Founder Console (#104) — the one read-only pane the owner reviews daily. Shows whether the platform
 * needs a human right now (the attention banner), the pending #13 approval queue with time-in-queue
 * (the decision SLA), fleet status, the #96 venture pipeline, #98 revenue/willingness-to-pay, #71
 * budget burn, and the kill/maintenance switches. Presentational: it takes a {@link FounderConsoleDto}
 * (fetched via `api.getFounderConsole`) so it renders deterministically and is unit-tested without a
 * store or network. It NEVER mutates — approve/kill/maintenance happen on their own surfaces.
 */
import { useState } from "react";
import type { FounderConsoleDto } from "../api/types.js";
import { VOICE } from "../brand.js";
import { EmptyState } from "./EmptyState.js";
import { PopLoader } from "./PopLoader.js";

/** Cents → a `$x.xx` string. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Seconds → a compact `2h`, `5m`, `30s` age. */
function age(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

/** MTTR (ms) → a human `2 hr`, `30 min`, or an em dash when nothing has resolved yet. */
function mttr(ms: number | null): string {
  if (ms === null) return "—";
  const min = Math.round(ms / 60_000);
  if (min >= 60) return `${(min / 60).toFixed(1)} hr`;
  return `${min} min`;
}

export interface FounderDashboardProps {
  console: FounderConsoleDto | null;
  /**
   * When provided, the kill switch / maintenance toggles become interactive (a confirm step → the
   * parent applies an optimistic flip and calls the real gated endpoint). Omit them and the switches
   * render read-only — the pure-component contract the dashboard has always had (#169 bug 12).
   */
  onToggleKillSwitch?: (next: boolean) => void;
  onToggleMaintenance?: (next: boolean) => void;
  /** Which switch (if any) has an in-flight request — disables that control and shows a working state. */
  switchBusy?: { kill?: boolean; maintenance?: boolean };
  /** A friendly, already-humanized error from the last toggle attempt. */
  switchError?: string | null;
}

export function FounderDashboard({
  console: data,
  onToggleKillSwitch,
  onToggleMaintenance,
  switchBusy,
  switchError,
}: FounderDashboardProps): React.JSX.Element {
  if (!data) {
    return (
      <section className="founder" aria-label="Founder console">
        <header className="founder__head">Founder Console</header>
        <PopLoader label="Loading the console…" />
      </section>
    );
  }

  const { fleet, venturePipeline, revenue, budget, pendingApprovals, switches, attention } = data;
  const reliability = data.reliability ?? {
    mttrMs: null,
    incidentsLast7d: 0,
    incidentsLast30d: 0,
    openCount: 0,
    total: 0,
    noisiestComponents: [],
  };

  return (
    <section className="founder" aria-label="Founder console">
      <header className="founder__head">Founder Console</header>

      {attention.required ? (
        <p className="founder__banner founder__banner--attention" role="alert">
          ⚠️ Needs you: {attention.reasons.join(" · ")}
        </p>
      ) : (
        <p className="founder__banner founder__banner--clear">✅ All clear — nothing needs you.</p>
      )}

      <div className="founder__grid">
        <article className="founder__card">
          <h3>Pending approvals</h3>
          {pendingApprovals.length === 0 ? (
            <EmptyState className="emptystate--compact">{VOICE.noPendingApprovals}</EmptyState>
          ) : (
            <ul className="founder__queue">
              {pendingApprovals.map((a) => (
                <li key={a.id} className="founder__queueitem">
                  <span className="founder__action">{a.actionType}</span>
                  <span className="founder__summary">{a.summary}</span>
                  {a.amount !== null && (
                    <span className="founder__amount">{dollars(a.amount)}</span>
                  )}
                  <span className="founder__age" title="time in queue">
                    {age(a.ageSeconds)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="founder__card">
          <h3>Fleet</h3>
          <dl className="founder__stats">
            <div>
              <dt>Active sessions</dt>
              <dd>{fleet.activeSessions}</dd>
            </div>
            <div>
              <dt>This window</dt>
              <dd>{fleet.sessionsThisWindow}</dd>
            </div>
            <div>
              <dt>Fleet in flight</dt>
              <dd>{fleet.globalInFlight}</dd>
            </div>
          </dl>
        </article>

        <article className="founder__card">
          <h3>Venture pipeline</h3>
          <dl className="founder__stats">
            <div>
              <dt>Active</dt>
              <dd>{venturePipeline.active}</dd>
            </div>
            <div>
              <dt>Funded</dt>
              <dd>{venturePipeline.funded}</dd>
            </div>
            <div>
              <dt>Killed</dt>
              <dd>{venturePipeline.killed}</dd>
            </div>
            <div>
              <dt>Escalated</dt>
              <dd>{venturePipeline.escalated}</dd>
            </div>
          </dl>
        </article>

        <article className="founder__card">
          <h3>Revenue</h3>
          <dl className="founder__stats">
            <div>
              <dt>Total</dt>
              <dd>{dollars(revenue.totalCents)}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd>{revenue.paymentCount}</dd>
            </div>
            <div>
              <dt>Willingness-to-pay</dt>
              <dd>
                {revenue.willingnessToPayCount}
                {revenue.hasWillingnessToPay ? " ✓" : ""}
              </dd>
            </div>
          </dl>
        </article>

        <article className="founder__card">
          <h3>Budget · {budget.window}</h3>
          {budget.overBudget && (
            <p className="founder__overbudget" role="alert">
              ⛔ Over budget — new sessions are halted.
            </p>
          )}
          <dl className="founder__stats">
            <div>
              <dt>Spent</dt>
              <dd>
                {dollars(budget.estimatedCostCents)}
                {budget.budgetCents > 0 && (
                  <>
                    {" "}
                    {" / "}
                    {dollars(budget.budgetCents)}
                  </>
                )}
              </dd>
            </div>
            {budget.utilization !== null && (
              <div>
                <dt>Utilization</dt>
                <dd>{Math.round(budget.utilization * 100)}%</dd>
              </div>
            )}
          </dl>
        </article>

        <article className="founder__card">
          <h3>Switches</h3>
          <dl className="founder__stats founder__switches">
            <SwitchControl
              label="Kill switch"
              on={switches.killSwitch}
              onLabel="🔴 engaged"
              offLabel="🟢 off"
              engageText="Engage"
              disengageText="Resume"
              confirmEngage="Engage the kill switch? This halts every autonomous session."
              confirmDisengage="Resume autonomy? Agents can act again."
              busy={switchBusy?.kill}
              onToggle={onToggleKillSwitch}
            />
            <SwitchControl
              label="Maintenance"
              on={switches.maintenance.enabled}
              onLabel="🔴 active"
              offLabel="🟢 off"
              engageText="Enable"
              disengageText="Disable"
              confirmEngage="Turn on maintenance? The platform goes read-only."
              confirmDisengage="Turn off maintenance? The platform accepts writes again."
              busy={switchBusy?.maintenance}
              unavailable={switches.maintenance.unavailable}
              onToggle={onToggleMaintenance}
            />
          </dl>
          {switchError && (
            <p className="founder__switch-error" role="alert">
              {switchError}
            </p>
          )}
        </article>

        <article className="founder__card">
          <h3>Reliability</h3>
          <dl className="founder__stats">
            <div>
              <dt>MTTR</dt>
              <dd>{mttr(reliability.mttrMs)}</dd>
            </div>
            <div>
              <dt>Open incidents</dt>
              <dd>{reliability.openCount}</dd>
            </div>
            <div>
              <dt>Last 7d / 30d</dt>
              <dd>
                {reliability.incidentsLast7d} / {reliability.incidentsLast30d}
              </dd>
            </div>
            <div>
              <dt>Noisiest</dt>
              <dd>
                {reliability.noisiestComponents.length === 0
                  ? "no incidents"
                  : reliability.noisiestComponents
                      .map((c) => `${c.service} (${c.count})`)
                      .join(", ")}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}

/**
 * One safety switch (kill switch or maintenance). Read-only when no `onToggle` is wired (the dashboard's
 * pure default) or when the backing state is `unavailable` — no fake toggle. When interactive, a click
 * opens a confirm step; confirming calls `onToggle(next)` and the parent applies the optimistic flip and
 * the real, human-gated request (#169 bug 12).
 */
function SwitchControl({
  label,
  on,
  onLabel,
  offLabel,
  engageText,
  disengageText,
  confirmEngage,
  confirmDisengage,
  busy,
  unavailable,
  onToggle,
}: {
  label: string;
  on: boolean;
  onLabel: string;
  offLabel: string;
  engageText: string;
  disengageText: string;
  confirmEngage: string;
  confirmDisengage: string;
  busy?: boolean;
  unavailable?: boolean;
  onToggle?: (next: boolean) => void;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const stateText = `${on ? onLabel : offLabel}${unavailable ? " (unknown)" : ""}`;

  // No control wired, or the state is unknown (store unreachable) → show the state, nothing to click.
  if (!onToggle || unavailable) {
    return (
      <div className="founder__switch">
        <dt>{label}</dt>
        <dd>
          {stateText}
          {unavailable && <span className="founder__switch-note"> · managed via config</span>}
        </dd>
      </div>
    );
  }

  const next = !on;
  return (
    <div className="founder__switch">
      <dt>{label}</dt>
      <dd>
        <span className="founder__switch-state">{stateText}</span>
        {confirming ? (
          <span
            className="founder__switch-confirm"
            role="group"
            aria-label={`Confirm ${label} change`}
          >
            <span className="founder__switch-prompt">
              {next ? confirmEngage : confirmDisengage}
            </span>
            <button
              type="button"
              className="btn btn--danger founder__switch-btn"
              onClick={() => {
                setConfirming(false);
                onToggle(next);
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="btn btn--ghost founder__switch-btn"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn founder__switch-btn"
            aria-pressed={on}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {busy ? "Working…" : on ? disengageText : engageText}
          </button>
        )}
      </dd>
    </div>
  );
}
