/**
 * Social publishing connectors (issue #742) — the module barrel: import the pure core from here.
 *
 * The problem it solves: ipop can render short-form video but has no path to distribute it. This module adds a
 * publishing core with one {@link PublishProvider} interface and three platform adapters (TikTok, Instagram
 * Reels, YouTube Shorts), all behind a hard approval gate. The contract a distribution agent follows:
 *
 *   1. Queue the publish:   const rec = await svc.queue({ workspaceId, platform, asset, caption, scheduleAt });
 *                           // creates a `queued` item — NOTHING posts; this is the swipe-approve item.
 *   2. A human approves it through the #13 swipe-approve flow, yielding an approvalRequestId.
 *   3. Publish on approval: await svc.publish(workspaceId, rec.id, { approvalRequestId });
 *                           // future scheduleAt ⇒ `scheduled`; else the provider posts once and records externalId.
 *
 * The guarantees are structural: `publish` refuses without an approval id, a disabled connector is an inert
 * no-op, and the production provider is the deterministic sandbox — so this change set cannot live-post. Like the
 * #670 action-gate / #587 arbiter, the change set touches no migration, schema barrel, or app-wiring registry;
 * `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgPublishStore` / `createDefaultSocialPublishingService`) lives in `./default.js` and
 * is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the service, provider seam, and store interface against the in-memory store and sandbox provider
 * without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
