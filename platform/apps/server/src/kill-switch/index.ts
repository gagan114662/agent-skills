/**
 * Fleet dead-man's switch (issue #592) — the module barrel: import everything from here.
 *
 * The problem (#592): a misbehaving loop can keep acting while the guard KPIs crater or spend spikes. The fix
 * is a fleet-wide tripwire + a manual global kill:
 *
 *   1. Each cycle, hand the current guard metrics to the service:
 *        const res = await svc.evaluate({ spendPerHourCents, errorRateBps, bounceRateBps });
 *      When a tripwire breaches, the GLOBAL switch engages in that same cycle (all agents pause) and the user
 *      is alerted — `res.tripped` is true and `res.paused` is true.
 *   2. An operator can halt the fleet by hand at any time:
 *        await svc.engage({ reason: "investigating a runaway", byMemberId });
 *   3. The single gate every agent admission / engine tick consults before acting:
 *        if (await svc.isFleetPaused()) return; // do not act while halted
 *   4. Resuming is a RECORDED human action:
 *        await svc.disengage({ byMemberId, reason: "root cause fixed" });
 *
 * This module does NO route/registry/migration wiring — it is a self-contained library other code calls, which
 * is why the #592 change set touches no migration, schema barrel, or app-wiring file (the #670 / #674 pattern).
 * `isFleetPaused` is the seam an operator wires into the #71 admission chokepoint / the engine ticks (which
 * already accept a `maintenancePaused?`-style pause check) in a follow-up.
 */

export * from "./tripwire.js";
export * from "./store.js";
export {
  KillSwitchService,
  KillSwitchError,
  type KillSwitchAlert,
  type KillSwitchAlertSink,
  type KillSwitchServiceDeps,
  type KillSwitchStatusReport,
  type EvaluateResult,
  type SwitchActionResult,
} from "./service.js";
export { resolveKillSwitchCaps, KILL_SWITCH_DEFAULTS, type KillSwitchCaps } from "./caps.js";
export {
  PgKillSwitchStore,
  createLogAlertSink,
  createDefaultKillSwitchService,
} from "./default.js";
