/**
 * Twitter/X posting + engagement agent (issue #596) — the module barrel: import the pure core from here.
 *
 * The problem it solves: there is no owned-audience growth loop on X. This module adds a pure compose core
 * (calendar topic → on-brand post/thread; relevant conversation → reply/like/repost) behind a hard approval
 * gate, with every published engagement logged and reversible. The contract a distribution agent follows:
 *
 *   1. Draft the action:    const rec = await svc.draftPost(ws, { topic, brief });   // or draftThread/draftReply/queueEngagement
 *                           // creates a `draft` item — NOTHING ships; this is the swipe-approve item.
 *   2. A human approves it through the #13 swipe-approve flow, yielding an approvalRequestId.
 *   3. Publish on approval: await svc.publish(ws, rec.id, { approvalRequestId });
 *                           // future scheduleAt ⇒ `scheduled`; else the provider posts/engages once and records externalId.
 *   4. Reverse if needed:   await svc.reverse(ws, rec.id, { approvalRequestId });     // undo a published engagement (also approval-gated)
 *
 * The guarantees are structural: `publish`/`reverse` refuse without an approval id, a disabled agent is an inert
 * no-op, and the production provider is the deterministic sandbox — so this change set cannot live-post. Like
 * the #670 action-gate / #742 social-publishing module, the change set touches no migration, schema barrel, or
 * app-wiring registry; `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgXActionStore` / `createDefaultXAgentService`) lives in `./default.js` and is
 * imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the service, compose core, provider seam, and store interface against the in-memory store and
 * sandbox provider without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./compose.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
