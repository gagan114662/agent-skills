/**
 * Cloud-scale usage dashboard (#71). Shows a tenant's current-window consumption (sessions,
 * compute, estimated cost vs budget), live in-flight concurrency (per tenant + per region), and a
 * prominent banner when the tenant is over budget (new launches are halted). Presentational: it
 * takes a {@link UsageReport} (fetched via `api.getScaleUsage`) so it renders deterministically and
 * is unit-tested without a store or network.
 */
import type { UsageReport } from "../api/types.js";
import { PopLoader } from "./PopLoader.js";

/** Cents → a `$x.xx` string. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function UsageDashboard({ usage }: { usage: UsageReport | null }): React.JSX.Element {
  if (!usage) {
    return (
      <section className="usage" aria-label="Usage">
        <header className="usage__head">Usage</header>
        <PopLoader label="Loading usage…" />
      </section>
    );
  }

  const { caps, inFlight } = usage;
  const regions = Object.keys(inFlight.byRegion);

  return (
    <section className="usage" aria-label="Usage">
      <header className="usage__head">
        Usage · <span className="usage__window">{usage.window}</span>
      </header>

      {usage.overBudget && (
        <p className="usage__banner" role="alert">
          ⛔ Tenant is over budget — new sessions are halted.
        </p>
      )}

      <dl className="usage__stats">
        <div>
          <dt>Sessions</dt>
          <dd>{usage.sessionsStarted}</dd>
        </div>
        <div>
          <dt>Compute</dt>
          <dd>{usage.computeSeconds}s</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <span className="usage__cost">{dollars(usage.estimatedCostCents)}</span>
            {caps.budgetCents > 0 && (
              <>
                {" / "}
                <span className="usage__cap">{dollars(caps.budgetCents)}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>In flight (tenant)</dt>
          <dd>
            {inFlight.tenant}
            {caps.tenantConcurrency > 0 ? ` / ${caps.tenantConcurrency}` : ""}
          </dd>
        </div>
        <div>
          <dt>In flight (fleet)</dt>
          <dd>{inFlight.global}</dd>
        </div>
      </dl>

      {regions.length > 0 && (
        <div className="usage__regions">
          <div className="usage__grouphead">By region</div>
          <ul>
            {regions.map((r) => (
              <li key={r}>
                <span className="usage__region">{r}</span>
                <span className="usage__regioncount">{inFlight.byRegion[r]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
