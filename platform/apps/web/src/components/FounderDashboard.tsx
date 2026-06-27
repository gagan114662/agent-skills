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

type EvidenceKind = "live" | "sample" | "dogfood" | "external";

function evidenceLabel(kind: EvidenceKind): string {
  switch (kind) {
    case "external":
      return "external customer proof";
    case "dogfood":
      return "dogfood";
    case "sample":
      return "sample";
    case "live":
      return "live";
  }
}

function EvidenceBadge({ kind }: { kind: EvidenceKind }): React.JSX.Element {
  return <span className={`founder__evidence founder__evidence--${kind}`}>{evidenceLabel(kind)}</span>;
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
  const proofScorecard = data.proofScorecard ?? { connectedCount: 0, total: 0, tiles: [] };
  const outreach = data.outreach ?? {
    experimentsRunning: 0,
    experimentsConcluded: 0,
    messagesPendingApproval: 0,
    messagesSent: 0,
    replies: 0,
    meetings: 0,
    signups: 0,
  };
  const hasExternalProof =
    revenue.paymentCount > 0 ||
    outreach.replies > 0 ||
    outreach.meetings > 0 ||
    outreach.signups > 0;
  const hasFirstRun = fleet.sessionsThisWindow > 0;
  const launchReadiness = [
    {
      label: "Auth",
      ready: hasFirstRun || fleet.activeSessions > 0,
      evidence: hasFirstRun || fleet.activeSessions > 0 ? "live" : "sample",
      detail: hasFirstRun ? "at least one agent run recorded" : "no signed-in run evidence yet",
    },
    {
      label: "Connectors",
      ready: proofScorecard.connectedCount > 0,
      evidence: proofScorecard.connectedCount > 0 ? "live" : "sample",
      detail:
        proofScorecard.total > 0
          ? `${proofScorecard.connectedCount}/${proofScorecard.total} proof sources connected`
          : "no proof sources connected yet",
    },
    {
      label: "First run",
      ready: hasFirstRun,
      evidence: hasFirstRun ? "live" : "sample",
      detail: `${fleet.sessionsThisWindow} sessions this window`,
    },
    {
      label: "Outbound",
      ready: outreach.messagesSent > 0 || outreach.messagesPendingApproval > 0,
      evidence: hasExternalProof ? "external" : outreach.messagesPendingApproval > 0 ? "live" : "sample",
      detail:
        outreach.messagesSent > 0
          ? `${outreach.messagesSent} sent, ${outreach.replies} replies`
          : `${outreach.messagesPendingApproval} sends waiting for approval`,
    },
    {
      label: "Billing",
      ready: budget.budgetCents > 0 || revenue.paymentCount > 0,
      evidence: revenue.paymentCount > 0 ? "external" : budget.budgetCents > 0 ? "live" : "sample",
      detail:
        revenue.paymentCount > 0
          ? `${revenue.paymentCount} payment receipts`
          : budget.budgetCents > 0
            ? `${dollars(budget.budgetCents)} cap set`
            : "no billing cap or payment receipt yet",
    },
    {
      label: "Observability",
      ready: true,
      evidence: "live",
      detail: `${reliability.openCount} open incidents, MTTR ${mttr(reliability.mttrMs)}`,
    },
    {
      label: "Legal/trust",
      ready: true,
      evidence: "dogfood",
      detail: "terms, privacy, refund, DPA, and security pages are published",
    },
  ] satisfies { label: string; ready: boolean; evidence: EvidenceKind; detail: string }[];

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
          <h3>Pending approvals <EvidenceBadge kind="live" /></h3>
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
          <h3>Fleet <EvidenceBadge kind="live" /></h3>
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
          <h3>Venture pipeline <EvidenceBadge kind="dogfood" /></h3>
          <dl className="founder__stats">
            <div>
              <dt>Active</dt>
              <dd>{venturePipeline.active}</dd>
            </div>
            <div>
              <dt>Funded</dt>
              <dd>{venturePipeline.funded}</dd>
            </div>
            {venturePipeline.scaffolds ? (
              <div title="Owner-activated ventures with zero autonomy budget until they clear the fundability gate">
                <dt>Scaffolds</dt>
                <dd>{venturePipeline.scaffolds}</dd>
              </div>
            ) : null}
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
          <h3>Revenue <EvidenceBadge kind={revenue.paymentCount > 0 ? "external" : "live"} /></h3>
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
          <h3>Budget · {budget.window} <EvidenceBadge kind="live" /></h3>
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
          <h3>Switches <EvidenceBadge kind="live" /></h3>
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
          <h3>Reliability <EvidenceBadge kind="live" /></h3>
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

        <article className="founder__card founder__card--wide">
          <h3>Launch readiness <EvidenceBadge kind={hasExternalProof ? "external" : "dogfood"} /></h3>
          <ul className="founder__readiness">
            {launchReadiness.map((item) => (
              <li key={item.label} className={item.ready ? "is-ready" : "is-waiting"}>
                <span className="founder__readiness-state" aria-hidden="true">
                  {item.ready ? "✓" : "·"}
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <EvidenceBadge kind={item.evidence} />
              </li>
            ))}
          </ul>
        </article>

        <article className="founder__card founder__card--wide">
          <h3>
            Proof scorecard{" "}
            <EvidenceBadge kind={proofScorecard.connectedCount > 0 ? "live" : "sample"} />
          </h3>
          {proofScorecard.tiles.length === 0 ? (
            <EmptyState className="emptystate--compact">
              No proof sources connected yet. Sample/demo rows stay out of live metrics.
            </EmptyState>
          ) : (
            <ul className="founder__proof">
              {proofScorecard.tiles.map((tile) => {
                const connected = tile.connection === "connected";
                return (
                  <li key={`${tile.department}-${tile.metricLabel}`} className={connected ? "is-live" : "is-sample"}>
                    <div>
                      <strong>{tile.title}</strong>
                      <span>{tile.metricLabel}</span>
                    </div>
                    <b>{connected ? tile.display : "not live"}</b>
                    <EvidenceBadge kind={connected ? "live" : "sample"} />
                    <small>{connected ? tile.source : "No real source receipt connected."}</small>
                  </li>
                );
              })}
            </ul>
          )}
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
