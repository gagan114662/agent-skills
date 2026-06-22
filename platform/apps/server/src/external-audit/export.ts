/**
 * Export the #672 external-action log (acceptance: "is exportable").
 *
 * Two pure shapes, no IO:
 *  - {@link toNdjson} — newline-delimited JSON, one sealed record per line. The streaming/archival form;
 *    each line is independently parseable and the `hash`/`prevHash` fields travel with it, so an exported
 *    file can be re-verified offline.
 *  - {@link toAuditExport} — a single JSON document bundling the records with a verification stamp and
 *    chain head, for a one-shot download whose integrity is self-describing.
 */

import { verifyChain } from "./chain.js";
import type { AuditRecord, VerifyResult } from "./types.js";

/** Serialize records as newline-delimited JSON (one record per line, chain order). */
export function toNdjson(records: readonly AuditRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

/** A self-describing export bundle: the records plus an integrity stamp over them. */
export interface AuditExport {
  /** Schema marker so a consumer can recognize the format. */
  format: "external-audit/v1";
  /** Tenant the export was scoped to, or null for an all-workspace export. */
  workspaceId: string | null;
  count: number;
  /** Hash of the last record (the chain head), or null for an empty export. */
  head: string | null;
  /** Integrity check run over `records` at export time. */
  verification: VerifyResult;
  records: AuditRecord[];
}

/** Build a verifiable JSON export bundle. `workspaceId` is recorded for provenance only. */
export function toAuditExport(records: readonly AuditRecord[], workspaceId: string | null = null): AuditExport {
  const list = [...records];
  return {
    format: "external-audit/v1",
    workspaceId,
    count: list.length,
    head: list.length > 0 ? (list[list.length - 1]?.hash ?? null) : null,
    verification: verifyChain(list),
    records: list,
  };
}
