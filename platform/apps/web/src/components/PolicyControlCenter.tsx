/**
 * Settings -> Policy control center (#1291). Presentational: ConsoleView supplies the live switch and
 * approval counts; the rows are static product policy examples from brand.ts so buyers can see how real
 * work routes before they hand agents live accounts.
 */
import { CONSOLE } from "../brand.js";

type PolicyOutcome = "auto" | "approval" | "blocked";

export interface PolicyControlCenterProps {
  killSwitchOn: boolean;
  maintenanceOn: boolean;
  pendingExternalActions: number;
  loggedDecisions: number;
  busy?: boolean;
  onToggleKillSwitch: (next: boolean) => void;
}

function outcomeLabel(outcome: PolicyOutcome): string {
  return CONSOLE.policy.outcomes[outcome];
}

export function PolicyControlCenter({
  killSwitchOn,
  maintenanceOn,
  pendingExternalActions,
  loggedDecisions,
  busy,
  onToggleKillSwitch,
}: PolicyControlCenterProps): React.JSX.Element {
  const copy = CONSOLE.policy;
  return (
    <section className="policy-center" aria-labelledby="policy-control-title">
      <p className="settings-eyebrow">{copy.eyebrow}</p>
      <h2 id="policy-control-title">{copy.title}</h2>
      <p className="settings-copy">{copy.sub}</p>

      <div className="policy-center__summary">
        <article className={killSwitchOn ? "policy-card policy-card--alert" : "policy-card"}>
          <div>
            <h3>{copy.breakGlassTitle}</h3>
            <strong>{killSwitchOn ? copy.breakGlassOn : copy.breakGlassOff}</strong>
            <p>{copy.breakGlassBody}</p>
          </div>
          <button
            type="button"
            className={killSwitchOn ? "btn" : "btn btn--danger"}
            disabled={busy}
            onClick={() => onToggleKillSwitch(!killSwitchOn)}
          >
            {busy ? copy.working : killSwitchOn ? copy.resume : copy.engage}
          </button>
        </article>
        <dl className="policy-center__counters">
          <div>
            <dt>{copy.pendingLabel}</dt>
            <dd>{pendingExternalActions}</dd>
          </div>
          <div>
            <dt>{copy.loggedLabel}</dt>
            <dd>{loggedDecisions}</dd>
          </div>
          <div>
            <dt>{copy.maintenanceLabel}</dt>
            <dd>{maintenanceOn ? copy.maintenanceOn : copy.maintenanceOff}</dd>
          </div>
        </dl>
      </div>

      <div className="policy-center__section">
        <h3>{copy.simulatorTitle}</h3>
        <p>{copy.simulatorSub}</p>
        <ul className="policy-center__rows">
          {copy.policyRows.map((row) => (
            <li key={row.area} className={"policy-row policy-row--" + row.outcome}>
              <span className="policy-row__area">{row.area}</span>
              <span>
                <strong>{row.action}</strong>
                <small>{row.reason}</small>
              </span>
              <b>{outcomeLabel(row.outcome as PolicyOutcome)}</b>
              <small className="policy-row__rollback">{row.rollback}</small>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
