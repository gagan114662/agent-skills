/**
 * Agent Garden settings panel (#284) — presentational. Browse the department fleet (the #282 registry
 * contracts, read from the server) and switch each agent on/off for this workspace. Read-only/draft agents
 * switch on directly; an outbound ("acts outside") agent needs the owner's approval first, so its control
 * parks a #13 request — the panel reflects that as "Awaiting your approval".
 *
 * Agent names, summaries, capabilities and the on/off state all come from the server (already sanitized);
 * only the chrome copy lives in brand.ts GARDEN (house rule: no hardcoded brand strings in product chrome).
 */
import { GARDEN } from "../brand.js";
import type { GardenAgentView, GardenResponse } from "../api/types.js";

export interface GardenProps {
  data: GardenResponse | null;
  busy?: boolean;
  error?: string | null;
  onEnable: (handle: string) => void;
  onDisable: (handle: string) => void;
}

/** The human label for an agent's risk tier (its blast radius) — all copy from brand.ts. */
function riskLabel(riskTier: GardenAgentView["riskTier"]): string {
  if (riskTier === "external_send") return GARDEN.riskExternalSend;
  if (riskTier === "internal_draft") return GARDEN.riskInternalDraft;
  return GARDEN.riskReadOnly;
}

export function Garden(props: GardenProps): React.JSX.Element {
  const { data, busy, error, onEnable, onDisable } = props;

  if (data === null) {
    return (
      <div className="garden">
        <h3>{GARDEN.title}</h3>
        <p className="garden__status">{GARDEN.loading}</p>
      </div>
    );
  }

  return (
    <div className="garden">
      <h3>{GARDEN.title}</h3>
      <p className="garden__hint">{GARDEN.hint}</p>
      {!data.canManage ? <p className="garden__rollout">{GARDEN.rollout}</p> : null}

      {data.agents.length === 0 ? (
        <p className="garden__status">{GARDEN.empty}</p>
      ) : (
        <ul className="garden__list">
          {data.agents.map((a) => (
            <GardenAgentRow
              key={a.handle}
              agent={a}
              canManage={data.canManage}
              busy={busy}
              onEnable={onEnable}
              onDisable={onDisable}
            />
          ))}
        </ul>
      )}

      {error ? (
        <p className="garden__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function GardenAgentRow(props: {
  agent: GardenAgentView;
  canManage: boolean;
  busy?: boolean;
  onEnable: (handle: string) => void;
  onDisable: (handle: string) => void;
}): React.JSX.Element {
  const { agent: a, canManage, busy, onEnable, onDisable } = props;
  return (
    <li className={`garden__item${a.active ? " garden__item--on" : ""}`}>
      <div className="garden__head">
        <span className="garden__name">{a.displayName}</span>
        <span className="garden__dept">{a.title}</span>
        <span className={`garden__risk garden__risk--${a.riskTier}`}>{riskLabel(a.riskTier)}</span>
        <span className="garden__price">{a.priceLabel}</span>
      </div>
      <p className="garden__summary">{a.summary}</p>
      {a.capabilities.length > 0 ? (
        <ul className="garden__caps">
          {a.capabilities.map((c) => (
            <li key={c} className="garden__cap">
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="garden__controls">
        {a.active ? <span className="garden__badge">{GARDEN.on}</span> : null}
        {a.state === "pending_approval" ? <span className="garden__pending">{GARDEN.pending}</span> : null}
        {!a.active && a.state !== "pending_approval" && a.inactiveReason ? (
          <span className="garden__reason">{a.inactiveReason}</span>
        ) : null}
        <GardenToggle agent={a} canManage={canManage} busy={busy} onEnable={onEnable} onDisable={onDisable} />
      </div>
    </li>
  );
}

function GardenToggle(props: {
  agent: GardenAgentView;
  canManage: boolean;
  busy?: boolean;
  onEnable: (handle: string) => void;
  onDisable: (handle: string) => void;
}): React.JSX.Element | null {
  const { agent: a, canManage, busy, onEnable, onDisable } = props;
  if (!canManage) return null;
  // An agent that is on (or awaiting approval to turn on) can be switched off; otherwise it can be switched
  // on. The "acts outside" tier shows it needs approval, so the owner knows the click parks a #13 request.
  if (a.state === "enabled" || a.state === "pending_approval") {
    return (
      <button type="button" className="garden__off" disabled={busy} onClick={() => onDisable(a.handle)}>
        {GARDEN.disable}
      </button>
    );
  }
  return (
    <button type="button" className="garden__on" disabled={busy} onClick={() => onEnable(a.handle)}>
      {GARDEN.enable}
      {a.requiresApprovalToEnable ? <span className="garden__gate"> · {GARDEN.needsApproval}</span> : null}
    </button>
  );
}
