/**
 * Per-channel spend governor (issue #591) — module barrel: import everything from here.
 *
 * The problem #591 fixes: autonomous agents drive paid channels (ads, email tooling, enrichment APIs) and,
 * left unbounded, could run up real money with no ceiling. The shape of the fix in code, end to end:
 *
 *   1. Build the service over its seams (or use the prod factory in `./default.js`):
 *        const svc = new SpendGovernorService({ store: new InMemoryChannelStore(), alertSink, caps, now });
 *   2. Set a per-channel cap (lowering needs no approval), then authorize each spend BEFORE it happens:
 *        await svc.lowerCap(ws, "ads", 10_000);              // $100/period cap
 *        const r = await svc.authorizeSpend(ws, "ads", 3_000); // reserves $30 if it fits
 *        if (!r.allowed) { ... }  // BLOCKED — raise the cap via a human-approved request
 *   3. Over-cap spend is BLOCKED. The only override is a recorded human approval:
 *        const raise = await svc.requestRaise(ws, "ads", memberId, 20_000);
 *        await svc.approveRaise(ws, raise.id, approverId);   // now the higher cap applies
 *   4. Current spend is always visible per channel: `await svc.statuses(ws)`.
 *
 * Caps refill each PERIOD (default daily) — the injected clock resets a channel's counters at each boundary.
 *
 * Default **OFF and inert** (`SPEND_GOVERNOR_ENABLED` unset/0): {@link SpendGovernorService.authorizeSpend}
 * allows everything and reserves nothing, so a deployment that sets nothing spends a deterministic $0 of real
 * money through this module.
 *
 * Self-contained, parallel-merge-safe (no migration, no schema barrel, no app-wiring registry, no web UI) —
 * the same conflict-free shape as #670 budget-governor, #622 hot-prospect, #611 lead-scoring. Distinct from
 * #670, which enforces a single GLOBAL cap; this enforces independent PER-CHANNEL, PER-PERIOD caps.
 *
 * This barrel deliberately does NOT re-export the Postgres binding (`PgChannelSpendStore` /
 * `createDefaultSpendGovernorService`): that lives in `./default.js` and pulls in the `pg` pool, so it is
 * imported only by the (future) route wiring. Keeping the barrel free of the DB dependency means any module or
 * test can import the governor + service + in-memory store without standing up Postgres.
 */

export {
  DEFAULT_ALERT_THRESHOLD_BPS,
  periodKeyFor,
  rollPeriod,
  channelSpendStatus,
  decideSpend,
  validateRaise,
  applyReserve,
  applySettle,
  applyRelease,
  applyLowerCap,
  applyRaiseCap,
  type ChannelSpendState,
  type ChannelSpendStatus,
  type ChannelSpendDecision,
  type RaiseValidation,
} from "./governor.js";
export {
  resolveSpendGovernorCaps,
  SPEND_GOVERNOR_DEFAULTS,
  DEFAULT_PERIOD_MS,
  type SpendGovernorCaps,
} from "./caps.js";
export {
  InMemoryChannelStore,
  ZERO_STATE,
  ZERO_RECORD,
  type ChannelSpendStore,
  type ChannelRecord,
  type ChannelRecordRow,
  type CapRaise,
  type CapRaiseStatus,
  type CreateRaiseInput,
  type DecideRaisePatch,
} from "./store.js";
export {
  SpendGovernorService,
  SpendGovernorError,
  type SpendGovernorDeps,
  type AuthorizeResult,
  type ChannelStatusRow,
  type RaiseDecisionResult,
  type AlertEvent,
  type AlertSink,
} from "./service.js";
