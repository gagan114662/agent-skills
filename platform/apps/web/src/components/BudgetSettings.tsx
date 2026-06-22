/**
 * Settings → Spend Cap (#670) — pure/presentational. Shows the workspace's global spend cap, how much is
 * committed + projected against it, and the pending cap-raises awaiting a human decision. It takes
 * already-fetched data ({@link BudgetStatusDto}, the pending {@link CapRaiseDto}s) plus action callbacks, so
 * it renders deterministically and is unit-tested without a store or network — the same container/
 * presentational split as {@link BillingSettings}. The container ({@link BudgetSettingsPanel}) fetches and
 * wires the callbacks to `api.budget`.
 *
 * Raising the cap is never a one-click act: it submits a request that a human must explicitly approve
 * (the recorded approval enforced server-side). Lowering the cap is immediate.
 */
import { useState } from "react";
import type { BudgetStatusDto, CapRaiseDto } from "../api/types.js";

/** Cents → a `$x.xx` string. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A dollar text input → integer cents (NaN-safe; negatives clamp to 0). */
function toCents(dollarsText: string): number {
  const n = Number(dollarsText);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

export interface BudgetSettingsProps {
  /** Whether the governor is enabled for this deployment (false → an off note). */
  enabled: boolean;
  /** The live spend position, or null while loading / when disabled. */
  status: BudgetStatusDto | null;
  /** Cap-raises awaiting a human decision. */
  pendingRaises: readonly CapRaiseDto[];
  /** Submit a request to raise the cap to `toCents` (parked for approval). */
  onRequestRaise: (toCents: number) => void;
  /** Lower the cap to `toCents` immediately. */
  onLower: (toCents: number) => void;
  /** Approve a pending cap-raise. */
  onApprove: (raiseId: string) => void;
  /** Reject a pending cap-raise. */
  onReject: (raiseId: string) => void;
  /** Disable controls while a mutation is in flight. */
  busy?: boolean;
}

export function BudgetSettings({
  enabled,
  status,
  pendingRaises,
  onRequestRaise,
  onLower,
  onApprove,
  onReject,
  busy = false,
}: BudgetSettingsProps): React.JSX.Element {
  const [raiseTo, setRaiseTo] = useState("");
  const [lowerTo, setLowerTo] = useState("");

  if (!enabled) {
    return (
      <section className="budget-settings workspace__panel" aria-label="Spend cap">
        <header className="budget-settings__head">
          <div className="budget-settings__eyebrow">Spend cap</div>
        </header>
        <p className="budget-settings__off">
          The spend cap governor is off for this workspace. Enable it to cap API + paid-action spend.
        </p>
      </section>
    );
  }

  const utilizationPct = status ? (status.utilizationBps / 100).toFixed(1) : "0.0";

  return (
    <section className="budget-settings workspace__panel" aria-label="Spend cap">
      <header className="budget-settings__head">
        <div className="budget-settings__eyebrow">Spend cap</div>
        {status?.halted && (
          <span className="budget-settings__badge budget-settings__badge--halted" role="status">
            Spend halted — cap reached
          </span>
        )}
        {status && !status.halted && status.alerting && (
          <span className="budget-settings__badge budget-settings__badge--alerting" role="status">
            Approaching cap
          </span>
        )}
      </header>

      <dl className="budget-settings__figures">
        <div>
          <dt>Cap</dt>
          <dd>{dollars(status?.capCents ?? 0)}</dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{dollars(status?.committedCents ?? 0)}</dd>
        </div>
        <div>
          <dt>Projected</dt>
          <dd>{dollars(status?.projectedCents ?? 0)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>{dollars(status?.availableCents ?? 0)}</dd>
        </div>
      </dl>
      <p className="budget-settings__utilization">{utilizationPct}% of cap used</p>

      <form
        className="budget-settings__raise"
        onSubmit={(e) => {
          e.preventDefault();
          const cents = toCents(raiseTo);
          if (cents > 0) onRequestRaise(cents);
          setRaiseTo("");
        }}
      >
        <label htmlFor="budget-raise-to">Request higher cap ($)</label>
        <input
          id="budget-raise-to"
          type="number"
          min="0"
          step="0.01"
          value={raiseTo}
          onChange={(e) => setRaiseTo(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || toCents(raiseTo) <= 0}>
          Request raise
        </button>
        <span className="budget-settings__hint">Raising the cap requires a human approval.</span>
      </form>

      <form
        className="budget-settings__lower"
        onSubmit={(e) => {
          e.preventDefault();
          onLower(toCents(lowerTo));
          setLowerTo("");
        }}
      >
        <label htmlFor="budget-lower-to">Lower cap ($)</label>
        <input
          id="budget-lower-to"
          type="number"
          min="0"
          step="0.01"
          value={lowerTo}
          onChange={(e) => setLowerTo(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          Lower cap
        </button>
      </form>

      <div className="budget-settings__raises" aria-label="Pending cap-raise requests">
        <h4>Pending cap raises</h4>
        {pendingRaises.length === 0 ? (
          <p className="budget-settings__empty">No pending cap-raise requests.</p>
        ) : (
          <ul>
            {pendingRaises.map((r) => (
              <li key={r.id} className="budget-settings__raise-row">
                <span className="budget-settings__raise-amount">
                  {dollars(r.fromCents)} → {dollars(r.toCents)}
                </span>
                <span className="budget-settings__raise-by">requested by {r.requestedByMemberId}</span>
                <button type="button" onClick={() => onApprove(r.id)} disabled={busy}>
                  Approve
                </button>
                <button type="button" onClick={() => onReject(r.id)} disabled={busy}>
                  Reject
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
