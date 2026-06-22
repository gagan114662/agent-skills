/**
 * Autonomy-by-default policy, web mirror (#760) — the single web-layer source of truth for "what state does
 * the Agent Garden show a capability in when the user has not chosen one?" It mirrors the server's #727
 * `autonomy-defaults` policy (the web can't import the server package, so — as with `store/mentions.ts` and
 * `blog/markdown.ts` — it keeps one deliberate, documented copy rather than a second ad-hoc default).
 *
 * The product promise (#727/#738) is: capabilities are ON out of the box, the user opts OUT of what they don't
 * want, money is the only hard gate, and three guards are always on. This module encodes exactly that so the
 * Garden UI never re-derives "default ON" inline:
 *
 *  - {@link AGENT_GARDEN_DEFAULT_ON} — every non-money capability defaults ON when no explicit preference is
 *    stored (the literal encoding of the server's `AUTONOMY_DEFAULTS_ALL_ON`).
 *  - Money-gated capabilities (the external-send tier) are ON-but-approval-gated: shown working, but every real
 *    spend/send still waits for the owner's approval — never auto-spend.
 *  - {@link ALWAYS_ON_GUARDS} — the kill-switch (#592), suppression/DNC (#594) and anti-injection (#674) guards
 *    are NOT toggles. They are orthogonal to this opt-out set and stay on regardless of any preference.
 *
 * Pure + total: no IO, no clock. {@link resolveGardenDisplay} is the one function the card reads.
 */
import type { GardenAgentView } from "../api/types.js";

/**
 * The default ON/OFF for a non-money capability with no stored preference. `true` ⇒ the agent is presented as
 * working out of the box; the user opts OUT. This is THE web default — read it, do not hardcode another.
 */
export const AGENT_GARDEN_DEFAULT_ON = true;

/**
 * The always-on guards (#592 / #594 / #674). They are never part of the opt-out capability set, never rendered
 * as a Garden toggle, and a preference can never switch them off — they protect the workspace regardless.
 */
export const ALWAYS_ON_GUARDS = ["kill-switch", "suppression", "anti-injection"] as const;
export type AlwaysOnGuard = (typeof ALWAYS_ON_GUARDS)[number];

const GUARD_SET: ReadonlySet<string> = new Set(ALWAYS_ON_GUARDS);

/** True iff `id` names one of the always-on guards — these are never toggleable in the Garden. */
export function isAlwaysOnGuard(id: string): boolean {
  return GUARD_SET.has(id);
}

/** The status word a card reads as, before brand copy is applied. */
export type GardenDisplayStatus = "on" | "pending" | "preparing" | "off";

/** The resolved presentation for one agent card — what the Garden renders, with the policy default applied. */
export interface GardenDisplay {
  /** Whether the switch shows ON. ON means "working"; for a money agent, working-but-approval-gated. */
  on: boolean;
  /** The status word the card reads as. */
  status: GardenDisplayStatus;
  /**
   * Whether this agent's real spend/sends wait for the owner's approval (the money/external-send tier). ON +
   * `approvalGated` is the "ON-but-approval-gated" state — never auto-spend.
   */
  approvalGated: boolean;
}

/**
 * Resolve how the Garden should present `agent`, applying the autonomy-by-default policy. The precedence:
 *
 *  1. An explicit stored opt-OUT (`userPreference === "off"`) always wins — a persisted OFF is respected.
 *  2. An agent parked in the #13 queue (`state === "pending_approval"`) reads as awaiting approval.
 *  3. A truly active agent (seeded + enabled) reads as ON; an enabled-but-not-yet-seeded one as "preparing".
 *  4. Otherwise — no explicit preference — the policy default applies: ON for every capability
 *     ({@link AGENT_GARDEN_DEFAULT_ON}). Money-gated agents are ON-but-`approvalGated`.
 *
 * Money-gating (`requiresApprovalToEnable`, the external-send tier) only ever ADDS the approval gate; it never
 * flips the default OFF — the card stays ON, the spend waits. Pure + total.
 */
export function resolveGardenDisplay(agent: GardenAgentView): GardenDisplay {
  const approvalGated = agent.requiresApprovalToEnable;

  // 1. Explicit opt-out — the one thing that turns a capability off. Persisted, and always respected.
  if (agent.userPreference === "off") {
    return { on: false, status: "off", approvalGated };
  }

  // 2. Parked for approval (a money agent the owner is switching on through the #13 queue).
  if (agent.state === "pending_approval") {
    return { on: true, status: "pending", approvalGated: true };
  }

  // 3. Reconciled real on (the server's production-grounded `active`), or enabled-but-not-yet-seeded.
  if (agent.active) {
    return { on: true, status: "on", approvalGated };
  }
  if (agent.state === "enabled") {
    return { on: true, status: "preparing", approvalGated };
  }

  // 4. No explicit preference → the autonomy default. Non-money: ON. Money: ON-but-approval-gated.
  return { on: AGENT_GARDEN_DEFAULT_ON, status: AGENT_GARDEN_DEFAULT_ON ? "on" : "off", approvalGated };
}
