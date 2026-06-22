/**
 * The shared persistence port for #584 handoff contracts.
 *
 * "Persisted to a shared store" (#584): the store is the single place every cross-agent handoff lives, so
 * any agent can read the handoff log and any receiver can look up the record it is being asked to accept.
 * The port is deliberately small — `put` (insert or replace by id), `get`, `list` — and the in-memory
 * implementation here keeps the module fully functional and unit-testable with no external dependency. A
 * durable (Postgres) store is a future, migration-gated follow-up (mirroring `external-audit`/`budget`);
 * keeping it out is what lets #584 ship as a self-contained module with no migration and no schema-barrel
 * edit, so it cannot collide with parallel work. A deployment swaps in a durable store via the service
 * constructor without touching any caller.
 */

import type { HandoffContract, HandoffStatus } from "./types.js";

/** Filter for reading the handoff log back (all optional; omitted ⇒ unfiltered). */
export interface HandoffListQuery {
  /** Scope to one tenant. */
  workspaceId?: string;
  /** Match handoffs where this handle is the `fromAgent` OR the `toAgent`. */
  agent?: string;
  /** Match a single lifecycle status. */
  status?: HandoffStatus;
}

/** The persistence port. `put` is an upsert by `id` so a status transition replaces the prior record. */
export interface HandoffStore {
  put(contract: HandoffContract): Promise<void>;
  get(id: string): Promise<HandoffContract | null>;
  list(query?: HandoffListQuery): Promise<HandoffContract[]>;
}

/**
 * Process-local store. Records are held by id; `list` returns them in creation order (the handoff log),
 * filtered by the query. Suitable for tests and single-process use.
 */
export class InMemoryHandoffStore implements HandoffStore {
  private readonly byId = new Map<string, HandoffContract>();

  async put(contract: HandoffContract): Promise<void> {
    this.byId.set(contract.id, contract);
  }

  async get(id: string): Promise<HandoffContract | null> {
    return this.byId.get(id) ?? null;
  }

  async list(query: HandoffListQuery = {}): Promise<HandoffContract[]> {
    let out = [...this.byId.values()];
    if (query.workspaceId !== undefined) {
      out = out.filter((c) => c.workspaceId === query.workspaceId);
    }
    if (query.agent !== undefined) {
      out = out.filter((c) => c.fromAgent === query.agent || c.toAgent === query.agent);
    }
    if (query.status !== undefined) {
      out = out.filter((c) => c.status === query.status);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }
}
