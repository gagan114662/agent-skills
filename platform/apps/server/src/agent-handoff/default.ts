/**
 * Production accessor for the #584 handoff service.
 *
 * Returns a process-wide singleton backed by the in-memory shared store — the one place every cross-agent
 * handoff in this process lives. A durable store is a future, migration-gated follow-up (see `store.ts`);
 * keeping it out here is what lets #584 ship as a self-contained module — no migration, no schema-barrel
 * edit, no app-registry wiring — so it cannot conflict with parallel work. Call-sites import
 * {@link defaultHandoffService} and propose/accept against it.
 */

import { HandoffService } from "./service.js";

let cached: HandoffService | null = null;

/** The shared handoff service (cheap to construct; all state lives in its store). */
export function defaultHandoffService(): HandoffService {
  cached ??= new HandoffService();
  return cached;
}
