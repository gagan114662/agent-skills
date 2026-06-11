/**
 * The pure, presentational pricing table (#125). Renders the three plan cards in ipop's voice — chatty
 * and warm, one wink in the footnote — with a playful "pop" entrance (CSS, staggered, no linear fades).
 * Kept free of fetch/store so it stays unit-testable; {@link PricingPanel} wires the data + checkout.
 */
import type { ActivePlanDto, PlanDto } from "@reload/shared";

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
        <h1 className="pricing__title">Pick your pop.</h1>
        <p className="pricing__lede">
          Three ways to hire a team of agents that actually ships. Start small, grow when you feel like it.
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
                onClick={() => onChoose(plan.key)}
              >
                {isCurrent ? "Your plan" : isPending ? "Opening checkout…" : "Choose"}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The one wink per surface (#122 voice). */}
      <p className="pricing__footnote">cancel anytime. the agents will be sad, but professional.</p>
    </div>
  );
}
