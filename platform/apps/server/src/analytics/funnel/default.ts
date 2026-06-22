/**
 * Full-funnel instrumentation — production wiring (#604).
 *
 * Binds the {@link FunnelService} to the default {@link InMemoryFunnelEventStore}. The store is process-
 * local, so a single shared service instance holds the funnel for the process lifetime; the route layer
 * reads it through {@link defaultFunnelService}. No config flag is read — recording a funnel event is
 * harmless + tenant-scoped, so ingest is always available (the #102 growth-loop convention).
 *
 * The store is the one seam to swap when a durable `funnel_events` table lands: replace the constructed
 * store here, and nothing else changes.
 */

import { FunnelService } from "./service.js";
import { InMemoryFunnelEventStore } from "./store.js";

/** The trailing window the funnel view reports over by default (mirrors `ANALYTICS_WINDOW_DAYS`). */
export const FUNNEL_DEFAULT_WINDOW_DAYS = 7;

let cached: FunnelService | null = null;

/** Singleton accessor for the funnel service (one process-local event store). */
export function defaultFunnelService(): FunnelService {
  cached ??= new FunnelService({ store: new InMemoryFunnelEventStore() });
  return cached;
}
