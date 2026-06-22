/**
 * Trend-ingestion source (issue #743) — the module barrel: import everything from here.
 *
 * The problem it solves: the video agent (#740) needs a ranked feed of what's trending in a niche — a `hook` to
 * open with and a `format` to shoot in — but there was no source producing one. This module ingests raw trends
 * from an injected source, ranks them with a pure deterministic core, dedupes + persists them in a self-managed
 * table, and returns the ranked `{ hook, format, niche, score, sourceRef }` list. The video agent consumes it
 * directly, or via `toVideoBriefs(records)` for the stripped input shape.
 *
 * Default-OFF + offline-safe: the feature ships dark. While `TRENDS_ENABLED` is unset (the default) the service
 * serves the deterministic in-repo FIXTURE and makes ZERO network calls; a live source only runs once enabled,
 * and even then falls back to the fixture on error. The change set touches no migration, schema barrel, app-
 * wiring registry, or web UI — `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgTrendStore` / `createDefaultTrendService`) lives in `./default.js` and is imported
 * DIRECTLY by app wiring — intentionally NOT re-exported here so pure consumers (and unit tests) can use the
 * ranking core, source seam, store interface, and service against an in-memory store without loading the
 * Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./score.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
