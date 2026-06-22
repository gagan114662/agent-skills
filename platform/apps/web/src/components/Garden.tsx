/**
 * Agent Garden settings panel (#284, premium polish #728) — presentational. Browse the department fleet
 * (the #282 registry contracts, read from the server) and switch each agent on/off for this workspace as
 * designed CAPABILITY CARDS: an agent avatar, role, human-readable capability names (never the raw ids the
 * server ships, e.g. `seo.audit`), a clean ON/OFF switch, and a "money-gated" badge on the agents that act
 * outside the building. Read-only/draft agents switch on directly; an outbound agent needs the owner's
 * approval first, so its control parks a #13 request — reflected as "Awaiting your approval".
 *
 * ON-by-default is the server's call (the #727 autonomy work): the card simply renders the switch in the
 * state the server reports (`a.active`). We never re-derive gating here, and we never echo the server's raw
 * `inactiveReason` string — the off state is shown as a calm, designed "Off", not "switch it on to work".
 *
 * Agent names, summaries, capabilities and the on/off state all come from the server (already sanitized);
 * only the chrome copy lives in brand.ts GARDEN (house rule: no hardcoded brand strings in product chrome).
 */
import { GARDEN, agentColor } from "../brand.js";
import { Avatar } from "./Primitives.js";
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

/** Short tokens that read better fully upper-cased than title-cased in a capability name. */
const CAP_ACRONYMS = new Set(["icp", "seo", "kpi", "roi", "cta", "url", "faq", "ab"]);

/**
 * Turn a raw capability id (`seo.audit`, `social.draft_thread`) into a human-readable name ("Audit",
 * "Draft thread"). We drop the namespace, split on word separators, title-case, and upper-case known
 * acronyms — so the card never shows a developer id, whatever the registry adds next.
 */
function humanizeCapability(id: string): string {
  const action = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  const words = action
    .split(/[._\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (CAP_ACRONYMS.has(lower)) return w.toUpperCase();
      // Sentence case — only the first word is capitalized, so chips read like prose ("Draft thread").
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    });
  const label = words.join(" ");
  return label.length > 0 ? label : id;
}

export function Garden(props: GardenProps): React.JSX.Element {
  const { data, busy, error, onEnable, onDisable } = props;

  if (data === null) {
    return (
      <div className="garden">
        <h3 className="garden__title">{GARDEN.title}</h3>
        <p className="garden__status">{GARDEN.loading}</p>
      </div>
    );
  }

  return (
    <div className="garden">
      <h3 className="garden__title">{GARDEN.title}</h3>
      <p className="garden__hint">{GARDEN.hint}</p>
      {!data.canManage ? <p className="garden__rollout">{GARDEN.rollout}</p> : null}

      {data.agents.length === 0 ? (
        <p className="garden__status">{GARDEN.empty}</p>
      ) : (
        <ul className="garden__grid">
          {data.agents.map((a) => (
            <GardenAgentCard
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

function GardenAgentCard(props: {
  agent: GardenAgentView;
  canManage: boolean;
  busy?: boolean;
  onEnable: (handle: string) => void;
  onDisable: (handle: string) => void;
}): React.JSX.Element {
  const { agent: a, canManage, busy, onEnable, onDisable } = props;
  const hue = agentColor(a.displayName);
  // The status the card reads as: On (live), Getting ready (toggled on but its agent isn't seeded yet),
  // Awaiting your approval (an outbound agent parked in #13), or a calm Off. We never render the server's
  // raw inactiveReason text.
  const statusLabel = a.active
    ? GARDEN.on
    : a.state === "pending_approval"
      ? GARDEN.pending
      : a.state === "enabled"
        ? GARDEN.preparing
        : GARDEN.off;
  const statusKind = a.active ? "on" : a.state === "pending_approval" ? "pending" : "off";
  // Show the "needs approval" hint only where the owner can act on it: an off, outbound agent they could
  // switch on. Once it's pending or on, the status line already says so.
  const showNeedsApproval = canManage && a.requiresApprovalToEnable && !a.active && a.state === "disabled";

  return (
    <li
      className={`garden-card garden-card--${statusKind}`}
      style={hue ? ({ "--pop-color": hue } as React.CSSProperties) : undefined}
    >
      <div className="garden-card__top">
        <Avatar name={a.displayName} kind="agent" />
        <div className="garden-card__id">
          <span className="garden-card__name">{a.displayName}</span>
          <span className="garden-card__role">{a.title}</span>
        </div>
        <GardenToggle agent={a} canManage={canManage} busy={busy} onEnable={onEnable} onDisable={onDisable} />
      </div>

      <p className="garden-card__summary">{a.summary}</p>

      <div className="garden-card__badges">
        <span className={`garden-card__risk garden-card__risk--${a.riskTier}`}>{riskLabel(a.riskTier)}</span>
        {a.requiresApprovalToEnable ? (
          <span className="garden-card__money" title={GARDEN.moneyGatedTitle}>
            {GARDEN.moneyGated}
          </span>
        ) : null}
        <span className="garden-card__price">{a.priceLabel}</span>
      </div>

      {a.capabilities.length > 0 ? (
        <div className="garden-card__caps">
          <span className="garden-card__caps-label">{GARDEN.capabilitiesLabel}</span>
          <ul className="garden-card__caplist">
            {a.capabilities.map((c) => (
              <li key={c} className="garden-card__cap">
                {humanizeCapability(c)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="garden-card__foot">
        <span className={`garden-card__status garden-card__status--${statusKind}`}>{statusLabel}</span>
        {showNeedsApproval ? <span className="garden-card__needs">{GARDEN.needsApproval}</span> : null}
      </div>
    </li>
  );
}

/**
 * The ON/OFF switch — a real toggle button styled as a switch (track + knob). An agent that is on (or
 * awaiting approval to turn on) can be switched off; otherwise it can be switched on. The accessible name
 * is the action (GARDEN.enable / GARDEN.disable), and `aria-checked` reflects the live state.
 */
function GardenToggle(props: {
  agent: GardenAgentView;
  canManage: boolean;
  busy?: boolean;
  onEnable: (handle: string) => void;
  onDisable: (handle: string) => void;
}): React.JSX.Element | null {
  const { agent: a, canManage, busy, onEnable, onDisable } = props;
  if (!canManage) return null;
  const isOn = a.state === "enabled" || a.state === "pending_approval";
  const label = isOn ? GARDEN.disable : GARDEN.enable;
  return (
    <button
      type="button"
      className={`garden-switch${isOn ? " garden-switch--on" : ""}`}
      aria-pressed={isOn}
      aria-label={label}
      disabled={busy}
      onClick={() => (isOn ? onDisable(a.handle) : onEnable(a.handle))}
    >
      <span className="garden-switch__track" aria-hidden="true">
        <span className="garden-switch__knob" />
      </span>
    </button>
  );
}
