/**
 * The append-only persistence port for the #672 external-action log.
 *
 * The store exposes exactly three operations — read the chain head, append, list — and *no* update or
 * delete. That shape is the append-only guarantee at the type level: a caller holding an
 * {@link AuditLogStore} has no method with which to rewrite history. A durable (Postgres) implementation
 * is a future, migration-gated ADR; per the #672 scope it is intentionally out of this module so the
 * change adds no migration and cannot collide with parallel schema work. The in-memory store here keeps
 * the module fully functional and unit-testable today.
 */

import type { AuditRecord } from "./types.js";

/** Filter for reading the log back (all optional; omitted ⇒ unfiltered). */
export interface AuditListQuery {
  workspaceId?: string;
  /** Max records returned, oldest-first (chain order). Default: all. */
  limit?: number;
}

/**
 * Append-only audit storage. Deliberately has no `update`/`delete`: history can only grow. `head`
 * returns the current last record (the link target for the next append) or null for an empty chain.
 */
export interface AuditLogStore {
  head(workspaceId: string): Promise<AuditRecord | null>;
  append(record: AuditRecord): Promise<void>;
  list(query?: AuditListQuery): Promise<AuditRecord[]>;
}

/**
 * Process-local, append-only store. Records are held per-workspace in insertion (chain) order. Suitable
 * for tests and single-process use; a deployment swaps in a durable store via the service constructor
 * without touching this module's callers.
 */
export class InMemoryAuditLogStore implements AuditLogStore {
  private readonly byWorkspace = new Map<string, AuditRecord[]>();

  async head(workspaceId: string): Promise<AuditRecord | null> {
    const chain = this.byWorkspace.get(workspaceId);
    return chain && chain.length > 0 ? (chain[chain.length - 1] ?? null) : null;
  }

  async append(record: AuditRecord): Promise<void> {
    const chain = this.byWorkspace.get(record.workspaceId) ?? [];
    chain.push(record);
    this.byWorkspace.set(record.workspaceId, chain);
  }

  async list(query: AuditListQuery = {}): Promise<AuditRecord[]> {
    let out: AuditRecord[];
    if (query.workspaceId !== undefined) {
      out = [...(this.byWorkspace.get(query.workspaceId) ?? [])];
    } else {
      out = [...this.byWorkspace.values()].flat().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
    }
    return query.limit !== undefined ? out.slice(0, query.limit) : out;
  }
}
