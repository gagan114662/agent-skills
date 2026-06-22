/**
 * AI UGC avatar studio (issue #741) — the module barrel: import everything from here.
 *
 * The problem it solves: short-form UGC creative wants a recurring, recognizable on-camera persona, but an
 * avatar/video render API is an external, money-and-rate-limited dependency. This module renders a persona into a
 * concrete face + voice CONFIG and guarantees the SAME `avatarId` always yields the SAME config, so a campaign's
 * avatar stays consistent clip to clip. Usage:
 *
 *   const svc = createDefaultAvatarStudioService();                 // production (Postgres + fake provider)
 *   if (svc.isEnabledFor(workspaceId)) {                            // OFF by default, owner-workspace-first
 *     const avatar = await svc.render({ workspaceId, persona });    // deterministic, persisted, consistent
 *   }
 *
 * Safe by default: the studio is OFF unless explicitly enabled, and the default provider is a deterministic FAKE
 * that calls nothing — so no external call happens until a deployment flips both. The change set touches no
 * migration, schema barrel, or app-wiring registry — `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgAvatarStudioStore` / `createDefaultAvatarStudioService`) lives in `./default.js` and
 * is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the derivation core, store interface, and service against an in-memory store without loading the
 * Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./render.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
