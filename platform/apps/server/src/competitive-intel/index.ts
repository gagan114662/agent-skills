/**
 * Competitive-intelligence monitoring (issue #619) — the module barrel: import everything from here.
 *
 * The problem it solves: positioning drifts when no one watches the competition. This module is the agent
 * that tracks each competitor's PRICING, MESSAGING, and LAUNCHES and, on a weekly cadence, emits a digest
 * highlighting the MATERIAL changes since the last snapshot — every change carrying its source (#619
 * acceptance). The contract a caller follows:
 *
 *   1. Generate the digest:   const { digest } = await svc.generateDigest({ workspaceId, competitors });
 *   2. Read the highlights:    digest.highlights   // skim-able "[PRICING] Acme: …" lines, each backed by
 *                              digest.changes[i].sourceUrl and digest.sources.
 *   3. The first run for a competitor is a BASELINE (no prior snapshot) — it reports new launches but no
 *      pricing/messaging "changes"; the NEXT run diffs all three dimensions against the stored snapshot.
 *
 * Default OFF: with `COMPETITIVE_INTEL_ENABLED` unset/false the service serves deterministic offline fake
 * data and makes NO external call (`servedBy: "fake-disabled"`). Like the #670/#587 modules, the change set
 * touches no migration, schema barrel, or app-wiring registry — `default.ts` self-manages its Postgres tables.
 *
 * The production binding (`PgCompetitiveIntelStore` / `createDefaultCompetitiveIntelService`) lives in
 * `./default.js` and is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that
 * pure consumers (and unit tests) can use the diff core, store interface, and service against an in-memory
 * store without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./detect.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
