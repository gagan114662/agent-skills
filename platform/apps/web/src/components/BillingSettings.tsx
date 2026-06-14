/**
 * The in-app Settings → Billing summary (#215) — pure/presentational. Shows the workspace's current plan,
 * this-window usage vs cap, and a clearly-marked test-mode note. It takes already-fetched data
 * ({@link ActivePlanDto}, the plan catalog, a {@link UsageReport}) so it renders deterministically and is
 * unit-tested without a store or network — the same container/presentational split as {@link UsageDashboard}
 * and {@link ConnectClaude}. The actual upgrade buttons (→ Stripe checkout) are the embedded
 * {@link PricingPanel}; this component is the summary that sits above it.
 */
import type { ActivePlanDto, PlanDto } from "@reload/shared";
import type { UsageReport } from "../api/types.js";
import { BILLING } from "../brand.js";

/** Cents → a `$x.xx` string. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function BillingSettings({
  current,
  plans,
  usage,
}: {
  current: ActivePlanDto | null;
  plans: readonly PlanDto[];
  usage: UsageReport | null;
}): React.JSX.Element {
  // The display name of the active plan (catalog lookup); a workspace with no activated plan is on trial.
  const planName = current ? (plans.find((p) => p.key === current.planKey)?.name ?? current.planKey) : null;
  const seats = current?.agentSeats ?? null;

  const spentCents = usage?.estimatedCostCents ?? 0;
  const capCents = usage?.caps.budgetCents ?? 0;

  return (
    <section className="billing-settings workspace__panel" aria-label={BILLING.panel.eyebrow}>
      <header className="billing-settings__head">
        <div className="billing-settings__eyebrow">{BILLING.panel.eyebrow}</div>
        <p className="billing-settings__blurb">{BILLING.panel.blurb}</p>
      </header>

      <dl className="billing-settings__facts">
        <div>
          <dt>{BILLING.panel.currentPlanLabel}</dt>
          <dd>
            <span className="billing-settings__plan">{planName ?? BILLING.panel.trialPlan}</span>
            {seats !== null && (
              <span className="billing-settings__seats">
                {" "}
                · {seats} {BILLING.panel.seatsSuffix}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{BILLING.panel.usageLabel}</dt>
          <dd>
            <span className="billing-settings__spent">{dollars(spentCents)}</span>
            {capCents > 0 ? (
              <span className="billing-settings__cap">
                {" "}
                / {dollars(capCents)} {BILLING.panel.capSuffix}
              </span>
            ) : (
              <span className="billing-settings__cap billing-settings__cap--none">
                {" "}
                · {BILLING.panel.noCap}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <p className="billing-settings__testmode" role="note">
        <strong>{BILLING.panel.testModeTitle}</strong>
        <span>{BILLING.panel.testModeBody}</span>
      </p>
    </section>
  );
}
