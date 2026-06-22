/**
 * Production accessor for the #672 external-action audit log.
 *
 * Returns a process-wide singleton backed by the in-memory append-only store. A durable store is a
 * future, migration-gated ADR (see {@link ./store.ts}); keeping it out here is what lets #672 ship as a
 * self-contained module — no migration, no schema-barrel edit, no app-registry wiring, so it cannot
 * conflict with parallel work. Outbound call-sites import {@link recordExternalAction} and record at the
 * point of side effect.
 */

import { ExternalActionAuditLog } from "./service.js";
import type { AuditRecord, ExternalActionInput } from "./types.js";

let cached: ExternalActionAuditLog | null = null;

/** The shared external-action audit log (cheap to construct; no per-call state beyond the store). */
export function defaultExternalAuditLog(): ExternalActionAuditLog {
  cached ??= new ExternalActionAuditLog();
  return cached;
}

/** Convenience: record one external action on the shared log. */
export function recordExternalAction(input: ExternalActionInput): Promise<AuditRecord> {
  return defaultExternalAuditLog().record(input);
}
