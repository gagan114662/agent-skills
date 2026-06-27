/**
 * The pure, presentational pricing table (#125). Renders the three plan cards in ipop's voice — chatty
 * and warm, one wink in the footnote — with a playful "pop" entrance (CSS, staggered, no linear fades).
 * Kept free of fetch/store so it stays unit-testable; {@link PricingPanel} wires the data + checkout.
 */
import type { ActivePlanDto, PlanDto } from "@reload/shared";
import { PRICING } from "../brand.js";
import { popConfetti } from "../lib/confetti.js";

/** Render whole-dollar prices cleanly: 4900¢ → "$49", 19900¢ → "$199". */
export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

export interface PricingTableProps {
  plans: PlanDto[];
  current: ActivePlanDto | null;
  /** Called with the plan key when a customer clicks "Choose". */
  onChoose: (planKey: string) => void;
  /** The plan whose checkout is mid-flight (button shows a working state). */
  pendingKey?: string | null;
  /** A friendly, already-humanized error to show above the grid (e.g. billing not enabled). */
  error?: string | null;
}

export function PricingTable({
  plans,
  current,
  onChoose,
  pendingKey,
  error,
}: PricingTableProps): React.JSX.Element {
  return (
    <div className="pricing">
      <header className="pricing__intro">
        <h1 className="pricing__title">{PRICING.tableTitle}</h1>
        <p className="pricing__lede">{PRICING.tableLede}</p>
      </header>

      {error && (
        <p className="pricing__error" role="alert">
          {error}
        </p>
      )}

      <ul className="pricing__grid">
        {plans.map((plan, i) => {
          const isCurrent = current?.planKey === plan.key;
          const isPending = pendingKey === plan.key;
          return (
            <li
              key={plan.key}
              className={`pricing-card pricing-card--pop${plan.featured ? " pricing-card--featured" : ""}${
                isCurrent ? " pricing-card--current" : ""
              }`}
              // Staggered pop entrance — each card lands a beat after the last.
              style={{ animationDelay: `${i * 90}ms` }}
            >
              {plan.featured && <span className="pricing-card__ribbon">{PRICING.popularBadge}</span>}
              <h2 className="pricing-card__name">{plan.name}</h2>
              <p className="pricing-card__price">
                <span className="pricing-card__amount">{formatPrice(plan.priceCents)}</span>
                <span className="pricing-card__period">/mo</span>
              </p>
              <p className="pricing-card__tagline">{plan.tagline}</p>
              <div className="pricing-card__value" aria-label={`Everyday value for ${plan.name}`}>
                <p className="pricing-card__value-label">{PRICING.everyDayLabel}</p>
                <p className="pricing-card__value-copy">{plan.dailyValue}</p>
              </div>
              <div className="pricing-card__limit">
                <p>
                  <span>{PRICING.limitLabel}</span> {plan.dailyLimit}
                </p>
                <p>
                  <span>{PRICING.upgradeLabel}</span> {plan.upgradeTrigger}
                </p>
              </div>
              <ul className="pricing-card__highlights">
                {plan.highlights.map((h) => (
                  <li key={h} className="pricing-card__highlight">
                    {h}
                  </li>
                ))}
              </ul>
              <button
                className="btn pricing-card__cta"
                aria-label={`Choose the ${plan.name} plan`}
                disabled={isCurrent || isPending}
                onClick={(e) => {
                  // A confetti pop at the CTA the moment checkout opens (#145 criterion #5).
                  const r = e.currentTarget.getBoundingClientRect();
                  popConfetti(r.left + r.width / 2, r.top + r.height / 2);
                  onChoose(plan.key);
                }}
              >
                {isCurrent ? PRICING.currentPlanCta : isPending ? PRICING.pendingCheckoutCta : PRICING.planCta}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The one wink per surface (#122 voice). */}
      <p className="pricing__footnote">{PRICING.tableFootnote}</p>
    </div>
  );
}
