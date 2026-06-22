/**
 * LinkedIn outreach agent (issue #595) — the module barrel: import the pure core from here.
 *
 * The problem it solves: ipop has no channel for high-intent B2B outreach where its buyers are. This module adds
 * an outreach core that turns a researched prospect + sender context into a personalized, value-first connection
 * request or message, all behind a hard approval gate and a daily send limit. The contract an outreach agent
 * follows:
 *
 *   1. Draft the touch:   const { touch } = await svc.draft({ workspaceId, kind, prospect, context });
 *                         // composes the body + creates a `drafted` item — NOTHING sends; this is the
 *                         // swipe-approve item, with the per-prospect context attached.
 *   2. A human approves it through the #13 swipe-approve flow, yielding an approvalRequestId.
 *   3. Send on approval:  await svc.send(workspaceId, touch.id, { approvalRequestId });
 *                         // enforces the daily limit, then the provider sends once and records the externalId.
 *
 * The guarantees are structural: `send` refuses without an approval id, respects the per-workspace daily cap, a
 * disabled connector is an inert no-op, and the production provider is the deterministic sandbox — so this change
 * set cannot live-send. Like the #670 action-gate / #587 arbiter, the change set touches no migration, schema
 * barrel, or app-wiring registry; `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgOutreachStore` / `createDefaultLinkedInOutreachService`) lives in `./default.js` and
 * is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the service, provider seam, and store interface against the in-memory store and sandbox provider
 * without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./compose.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
