/**
 * Persistence seam for run-timeout tracking (issue #635). The narrow interface the service consumes:
 * insert a run, patch it, read one back (workspace-scoped), and enumerate every still-`running` run so
 * the sweep can find the hung ones. The production binding is the self-managed Postgres store in
 * `default.ts`; unit tests inject {@link InMemoryRunTimeoutStore}, so the service is tested with no
 * database (the #17 pure-decision + injected-seam pattern).
 *
 * Tenant reads (`get`, `listByWorkspace`) take a `workspaceId` and only ever return that tenant's runs
 * (the #3 IDOR boundary). The by-`runId` mutators (`patch`) and the cross-tenant `listRunning` are
 * system operations keyed by the server-issued, unguessable run id — never reachable from a tenant
 * request — exactly like the worktree pool keying off its server-issued session id.
 */

import type { RunTimeoutPatch, RunTimeoutRecord } from "./types.js";

export interface RunTimeoutStore {
  /** Persist a new run record. Rejects (throws) if `runId` already exists. */
  insert(record: RunTimeoutRecord): Promise<RunTimeoutRecord>;
  /** Load one run within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, runId: string): Promise<RunTimeoutRecord | null>;
  /** Load one run by id (system op — used by lifecycle mutators that already hold the server-issued id). */
  getByRunId(runId: string): Promise<RunTimeoutRecord | null>;
  /** Apply a sparse patch by id; returns the updated record, or null if no such run. */
  patch(runId: string, patch: RunTimeoutPatch): Promise<RunTimeoutRecord | null>;
  /** Every run still in the `running` state (system op — drives the sweep across all tenants). */
  listRunning(): Promise<RunTimeoutRecord[]>;
  /** A workspace's runs, newest first (#3 IDOR scoping). */
  listByWorkspace(workspaceId: string): Promise<RunTimeoutRecord[]>;
}

/** Deterministic in-memory store for unit tests (no clock, no DB). Returns deep copies so callers can't mutate internal state. */
export class InMemoryRunTimeoutStore implements RunTimeoutStore {
  private readonly rows = new Map<string, RunTimeoutRecord>();

  async insert(record: RunTimeoutRecord): Promise<RunTimeoutRecord> {
    if (this.rows.has(record.runId)) {
      throw new Error(`run-timeout: run ${record.runId} already tracked`);
    }
    this.rows.set(record.runId, { ...record });
    return { ...record };
  }

  async get(workspaceId: string, runId: string): Promise<RunTimeoutRecord | null> {
    const row = this.rows.get(runId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return { ...row };
  }

  async getByRunId(runId: string): Promise<RunTimeoutRecord | null> {
    const row = this.rows.get(runId);
    return row ? { ...row } : null;
  }

  async patch(runId: string, patch: RunTimeoutPatch): Promise<RunTimeoutRecord | null> {
    const row = this.rows.get(runId);
    if (!row) return null;
    const updated: RunTimeoutRecord = { ...row, ...patch };
    this.rows.set(runId, updated);
    return { ...updated };
  }

  async listRunning(): Promise<RunTimeoutRecord[]> {
    return [...this.rows.values()].filter((r) => r.status === "running").map((r) => ({ ...r }));
  }

  async listByWorkspace(workspaceId: string): Promise<RunTimeoutRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.runId < b.runId ? 1 : -1))
      .map((r) => ({ ...r }));
  }
}
