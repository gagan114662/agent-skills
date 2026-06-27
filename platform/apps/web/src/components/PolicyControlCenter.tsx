/**
 * Settings -> Policy control center (#1291). ConsoleView supplies live switches, counts, and the backend
 * simulator; static rows stay as rollback examples for the common external-action classes.
 */
import { useState } from "react";
import type { PolicySimulationInput, PolicySimulationResult } from "@reload/shared";
import { CONSOLE } from "../brand.js";

type PolicyOutcome = "auto" | "approval" | "blocked";

export interface PolicyControlCenterProps {
  killSwitchOn: boolean;
  maintenanceOn: boolean;
  pendingExternalActions: number;
  loggedDecisions: number;
  busy?: boolean;
  onToggleKillSwitch: (next: boolean) => void;
  onSimulatePolicy?: (input: PolicySimulationInput) => Promise<PolicySimulationResult>;
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
  onSimulatePolicy,
}: PolicyControlCenterProps): React.JSX.Element {
  const copy = CONSOLE.policy;
  const [actionType, setActionType] = useState("external.send");
  const [amount, setAmount] = useState("");
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<PolicySimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function simulate(): Promise<void> {
    if (!onSimulatePolicy || simulating) return;
    setSimulating(true);
    setError(null);
    try {
      const trimmedAmount = amount.trim();
      const result = await onSimulatePolicy({
        actionType: actionType.trim(),
        amount: trimmedAmount === "" ? null : Number(trimmedAmount),
      });
      setSimulation(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Policy simulation failed");
    } finally {
      setSimulating(false);
    }
  }

  const simulatedOutcome =
    simulation?.outcome === "auto_runs" ? "auto" : simulation?.outcome === "queues_for_approval" ? "approval" : "blocked";

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
        {onSimulatePolicy && (
          <form
            className="policy-simulator"
            onSubmit={(event) => {
              event.preventDefault();
              void simulate();
            }}
          >
            <label>
              Action type
              <input
                value={actionType}
                onChange={(event) => setActionType(event.target.value)}
                placeholder="external.send"
                aria-label="Action type to simulate"
              />
            </label>
            <label>
              Amount
              <input
                type="number"
                min="0"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="optional"
                aria-label="Amount to simulate"
              />
            </label>
            <button type="submit" className="btn btn--primary" disabled={simulating || actionType.trim() === ""}>
              {simulating ? copy.working : copy.simulate}
            </button>
          </form>
        )}
        {error && (
          <p className="policy-simulator__error" role="alert">
            {error}
          </p>
        )}
        {simulation && (
          <article className={"policy-simulator__result policy-row--" + simulatedOutcome}>
            <span>{simulation.actionType}</span>
            <b>{outcomeLabel(simulatedOutcome)}</b>
            <small>{simulation.reason}</small>
            <small className="policy-row__rollback">{simulation.rollbackStatus}</small>
          </article>
        )}
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
