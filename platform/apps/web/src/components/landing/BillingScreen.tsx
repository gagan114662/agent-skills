/**
 * Pricing dressed as the product's own Settings → Billing screen (#165). Instead of three floating
 * marketing cards, the visitor sees exactly where they'll land: the settings chrome with a left nav,
 * the "Plan & billing" pane, and the three plans rendered as selectable subscription cards — the Pro
 * tier shown as the current plan. The plans mirror `LANDING.plans` (which mirror `billing/plans.ts`,
 * #125), so the one source of pricing truth still lives in one place.
 *
 * All copy from `brand.ts`; brand.test scans this file for hardcoded strings.
 */
import { BILLING, LANDING } from "../../brand.js";
import { Link } from "../../routing.js";

export function BillingScreen(): React.JSX.Element {
  return (
    <div className="billing-chrome" role="img" aria-label="The in-app billing screen">
      <div className="billing-chrome__bar" aria-hidden="true">
        <span className="billing-chrome__crumb">{BILLING.settingsLabel}</span>
        <span className="billing-chrome__sep">/</span>
        <span className="billing-chrome__crumb is-active">{BILLING.billingLabel}</span>
      </div>
      <div className="billing-chrome__body">
        <nav className="billing-chrome__nav" aria-hidden="true">
          {BILLING.navItems.map((item) => (
            <span
              key={item}
              className={`billing-chrome__nav-item${
                item === BILLING.billingLabel ? " is-active" : ""
              }`}
            >
              {item}
            </span>
          ))}
        </nav>
        <div className="billing-chrome__pane">
          <h3 className="billing-chrome__heading">{BILLING.heading}</h3>
          <p className="billing-chrome__sub">{BILLING.subheading}</p>
          <ul className="billing-chrome__plans">
            {LANDING.plans.map((plan) => {
              const isCurrent = plan.name === BILLING.currentPlan;
              return (
                <li
                  key={plan.name}
                  className={`billing-plan${plan.featured ? " billing-plan--featured" : ""}${
                    isCurrent ? " is-current" : ""
                  }`}
                >
                  <div className="billing-plan__head">
                    <span className="billing-plan__name">{plan.name}</span>
                    {isCurrent && <span className="billing-plan__current">{BILLING.currentLabel}</span>}
                  </div>
                  <p className="billing-plan__price">
                    <span className="billing-plan__amount">{plan.price}</span>
                    <span className="billing-plan__period">{BILLING.perMonth}</span>
                  </p>
                  <p className="billing-plan__tagline">{plan.tagline}</p>
                  <Link
                    href="/signup"
                    className={`btn billing-plan__cta${
                      plan.featured ? " btn--primary" : ""
                    }`}
                  >
                    {isCurrent ? BILLING.currentLabel : BILLING.selectLabel}
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="billing-chrome__footnote">{BILLING.footnote}</p>
        </div>
      </div>
    </div>
  );
}
