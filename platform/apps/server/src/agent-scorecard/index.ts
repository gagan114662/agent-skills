/**
 * Per-agent performance scorecard tied to conversions (issue #593) — the module barrel: import everything from here.
 *
 * The problem #593 fixes: there is no way to know which agent (and channel) actually drove paying customers. This
 * module attributes PIPELINE and REVENUE back to the originating agent + channel, updated as conversions land, and
 * ranks agents by influence so the user can see who is producing. Usage:
 *
 *   const svc = createDefaultScorecardService();          // production (Postgres + fake source)
 *   if (svc.isEnabledFor(workspaceId)) {                  // OFF by default, owner-workspace-first
 *     await svc.sync(workspaceId);                        // ingest the latest conversions (idempotent)
 *     const card = await svc.getScorecard(workspaceId);   // ranked, conversion-tied scorecard
 *     // card.agents[0] is the top influencer; card.agents[i].summary explains why.
 *   }
 *
 * Or use the pure core directly on data you already have:
 *
 *   const card = buildScorecard({ events, activities });  // no IO, no clock — deterministic
 *
 * Safe by default: the scorecard is OFF unless explicitly enabled, and the default source is a deterministic FAKE
 * that queries nothing — so no external call happens until a deployment flips both. The change set touches no
 * migration, schema barrel, or app-wiring registry — `default.ts` self-manages its two Postgres tables.
 *
 * The production binding (`PgScorecardStore` / `createDefaultScorecardService`) lives in `./default.js` and is
 * imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the scoring core, store/source interfaces, and service against in-memory seams without loading
 * the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./score.js";
export * from "./source.js";
export * from "./store.js";
export * from "./service.js";
