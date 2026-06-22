/**
 * Autonomy defaults (issue #727) — "Autonomy by default: money is the only hard gate." This is the module barrel:
 * import everything from here. It is the single source of truth for the product promise — a fresh or existing
 * workspace has ALL agent capabilities ON out of the box and produces work with zero switch-flipping; the ONLY
 * hard, code-enforced approval gate is money/spend.
 *
 * The contract a caller follows before it acts:
 *
 *   1. Resolve the workspace's opt-out caps (all-ON default):  const caps = resolveAutonomyCaps(env);
 *   2. Rule on the proposed action:                            const d = decideAutonomy(action, caps);
 *      if (d.mode === "autonomous") { …run it… }                // drafts, publishing, non-paid outreach, deploys
 *      else { …route to the #13 approval queue… }               // d.gate === "money" (hard) or a dialed-off toggle
 *
 * The guarantee is structural and inverted from the usual fail-closed safety gates (#670/#674): only a money
 * action (or a capability/channel the user deliberately dialed off) pauses. Three guards stay ALWAYS ON and are
 * NOT in this toggle set — the kill-switch (#592), suppression / opt-out / DNC (#594), and anti-injection (#674);
 * a caller runs them independently of, and they are never weakened by, this decision.
 *
 * Nothing here does IO or wires into a route/registry/migration — it is a pure, env-resolved library other
 * modules call (the #592 / #670 / #674 self-contained pattern). The consumption seam (garden enable, sender
 * actuators, the connections approval message) adopts it in a follow-up.
 */

import { resolveAutonomyCaps } from "./caps.js";
import { decideAutonomy, type AutonomyActionDescriptor, type AutonomyDecision } from "./policy.js";

export * from "./defaults.js";
export * from "./money.js";
export * from "./policy.js";
export { resolveAutonomyCaps } from "./caps.js";

/**
 * One-call convenience: resolve the env-backed caps and decide in a single step. Pure given its `env` argument.
 * The common path for a caller that does not already hold a resolved {@link import("./defaults.js").AutonomyCaps}.
 */
export function decideAutonomyFromEnv(
  action: AutonomyActionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): AutonomyDecision {
  return decideAutonomy(action, resolveAutonomyCaps(env));
}
