/**
 * The in-app Settings → Billing summary (#215) — pure/presentational. Shows the workspace's current plan,
 * this-window usage vs cap, and a clearly-marked test-mode note. It takes already-fetched data
 * ({@link ActivePlanDto}, the plan catalog, a {@link UsageReport}) so it renders deterministically and is
 * unit-tested without a store or network — the same container/presentational split as {@link UsageDashboard}
 * and {@link ConnectClaude}. The actual upgrade buttons (→ Stripe checkout) are the embedded
 * {@link PricingPanel}; this component is the summary that sits above it.
 */
import type { ActivePlanDto, BillingInvoiceDto, PlanDto } from "@reload/shared";
import type { UsageReport } from "../api/types.js";
import { BILLING } from "../brand.js";

/** Cents → a `$x.xx` string. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function BillingSettings({
  current,
  plans,
  usage,
  live = false,
  invoices = [],
}: {
  current: ActivePlanDto | null;
  plans: readonly PlanDto[];
  usage: UsageReport | null;
  /** #481 go-live: true once real payments are on (stripe + live mode) — flips the safety note. */
  live?: boolean;
  invoices?: readonly BillingInvoiceDto[];
}): React.JSX.Element {
  // The display name of the active plan (catalog lookup); a workspace with no activated plan is on trial.
  const activePlan = current ? plans.find((p) => p.key === current.planKey) : null;
  const planName = current ? (activePlan?.name ?? current.planKey) : null;
  const seats = current?.agentSeats ?? null;

  const spentCents = usage?.estimatedCostCents ?? 0;
  const capCents = usage?.caps.budgetCents ?? 0;
  const remainingCents = Math.max(0, capCents - spentCents);
  const usedPercent = capCents > 0 ? clampPercent((spentCents / capCents) * 100) : 0;
  const overBudget = Boolean(usage?.overBudget) || (capCents > 0 && spentCents >= capCents);
  const nearCap = !overBudget && capCents > 0 && usedPercent >= 80;
  const valueTitle =
    capCents <= 0
      ? BILLING.panel.valueNoCapTitle
      : overBudget
        ? BILLING.panel.valuePausedTitle
        : nearCap
          ? BILLING.panel.valueNearCapTitle
          : BILLING.panel.valueReadyTitle;
  const valueBody =
    capCents <= 0
      ? BILLING.panel.valueNoCapBody
      : overBudget
        ? BILLING.panel.valuePausedBody(dollars(capCents))
        : nearCap
          ? BILLING.panel.valueNearCapBody(dollars(remainingCents), dollars(capCents))
          : BILLING.panel.valueReadyBody(dollars(remainingCents), dollars(capCents));

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

      <section
        className={`billing-settings__value${overBudget ? " billing-settings__value--paused" : nearCap ? " billing-settings__value--near" : ""}`}
        aria-label={BILLING.panel.valueTitle}
      >
        <div className="billing-settings__value-head">
          <div>
            <p className="billing-settings__value-kicker">{BILLING.panel.valueTitle}</p>
            <h3>{valueTitle}</h3>
          </div>
          {capCents > 0 && <strong>{usedPercent}%</strong>}
        </div>
        <div
          className="billing-settings__meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={capCents > 0 ? capCents : 100}
          aria-valuenow={capCents > 0 ? Math.min(spentCents, capCents) : 0}
          aria-label={BILLING.panel.usageLabel}
        >
          <span style={{ width: `${usedPercent}%` }} />
        </div>
        <p className="billing-settings__value-body">{valueBody}</p>
        {activePlan && (
          <dl className="billing-settings__plan-value">
            <div>
              <dt>{BILLING.panel.dailyValueLabel}</dt>
              <dd>{activePlan.dailyValue}</dd>
            </div>
            <div>
              <dt>{BILLING.panel.dailyLimitLabel}</dt>
              <dd>{activePlan.dailyLimit}</dd>
            </div>
            <div>
              <dt>{BILLING.panel.upgradeTriggerLabel}</dt>
              <dd>{activePlan.upgradeTrigger}</dd>
            </div>
          </dl>
        )}
      </section>

      <p
        className={`billing-settings__testmode${live ? " billing-settings__testmode--live" : ""}`}
        role="note"
      >
        <strong>{live ? BILLING.panel.liveModeTitle : BILLING.panel.testModeTitle}</strong>
        <span>{live ? BILLING.panel.liveModeBody : BILLING.panel.testModeBody}</span>
      </p>

      <section className="billing-settings__invoices" aria-label={BILLING.panel.invoicesTitle}>
        <h3>{BILLING.panel.invoicesTitle}</h3>
        {invoices.length === 0 ? (
          <p>{BILLING.panel.noInvoices}</p>
        ) : (
          <ul>
            {invoices.map((invoice) => {
              const href = invoice.invoicePdfUrl ?? invoice.hostedInvoiceUrl;
              return (
                <li key={invoice.providerInvoiceId}>
                  <span>{invoice.number ?? invoice.providerInvoiceId}</span>
                  <span>{dollars(invoice.amountCents)}</span>
                  {href && (
                    <a href={href} target="_blank" rel="noreferrer">
                      {invoice.invoicePdfUrl ? BILLING.panel.invoicePdfLabel : BILLING.panel.invoiceLinkLabel}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
