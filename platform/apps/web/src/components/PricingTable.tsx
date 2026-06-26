/**
 * The pure, presentational pricing table (#125). Renders the three plan cards in ipop's voice — chatty
 * and warm, one wink in the footnote — with a playful "pop" entrance (CSS, staggered, no linear fades).
 * Kept free of fetch/store so it stays unit-testable; {@link PricingPanel} wires the data + checkout.
 */
import type { ActivePlanDto, PlanDto } from "@reload/shared";
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
        <h1 className="pricing__title">Keep the agents working.</h1>
        <p className="pricing__lede">
          Start free, see useful work every day, then upgrade when you want more campaigns, more agents,
          or more live work moving at once.
        </p>
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
              {plan.featured && <span className="pricing-card__ribbon">Most popular</span>}
              <h2 className="pricing-card__name">{plan.name}</h2>
              <p className="pricing-card__price">
                <span className="pricing-card__amount">{formatPrice(plan.priceCents)}</span>
                <span className="pricing-card__period">/mo</span>
              </p>
              <p className="pricing-card__tagline">{plan.tagline}</p>
              <div className="pricing-card__value" aria-label={`Everyday value for ${plan.name}`}>
                <p className="pricing-card__value-label">Every day</p>
                <p className="pricing-card__value-copy">{plan.dailyValue}</p>
              </div>
              <div className="pricing-card__limit">
                <p>
                  <span>Limit:</span> {plan.dailyLimit}
                </p>
                <p>
                  <span>Upgrade:</span> {plan.upgradeTrigger}
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
                {isCurrent ? "Your plan" : isPending ? "Opening checkout…" : "Keep them working"}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The one wink per surface (#122 voice). */}
      <p className="pricing__footnote">
        everyday work is capped before spend gets silly. the agents are enthusiastic; billing is not.
      </p>
    </div>
  );
}
