/**
 * Persistence seam for run-recovery tracking (issue #643). The narrow interface the service consumes:
 * insert a run, patch it, read one back (workspace-scoped), and — the heart of the fix — enumerate every
 * *orphaned* run (still `running` but owned by a dead instance) so the boot pass can reconcile them. The
 * production binding is the self-managed Postgres store in `default.ts`; unit tests inject
 * {@link InMemoryRunRecoveryStore}, so the service is tested with no database (the #17 pure-decision +
 * injected-seam pattern).
 *
 * Tenant reads (`get`, `listByWorkspace`) take a `workspaceId` and only ever return that tenant's runs
 * (the #3 IDOR boundary). The by-`runId` mutators (`patch`) and the cross-tenant `listOrphaned` are
 * system operations keyed by the server-issued, unguessable run id / instance id — never reachable from a
 * tenant request — exactly like the run-timeout sweep keying off its server-issued run id.
 */

import type { RunRecord, RunRecordPatch } from "./types.js";

export interface RunRecoveryStore {
  /** Persist a new run record. Rejects (throws) if `runId` already exists. */
  insert(record: RunRecord): Promise<RunRecord>;
  /** Load one run within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, runId: string): Promise<RunRecord | null>;
  /** Load one run by id (system op — used by lifecycle mutators that already hold the server-issued id). */
  getByRunId(runId: string): Promise<RunRecord | null>;
  /** Apply a sparse patch by id; returns the updated record, or null if no such run. */
  patch(runId: string, patch: RunRecordPatch): Promise<RunRecord | null>;
  /**
   * Every orphaned run: still `running` but owned by an instance other than `liveInstanceId` (system op —
   * drives the boot recovery pass across all tenants). Ordered oldest-first for deterministic recovery.
   */
  listOrphaned(liveInstanceId: string): Promise<RunRecord[]>;
  /** A workspace's runs, newest first (#3 IDOR scoping). */
  listByWorkspace(workspaceId: string): Promise<RunRecord[]>;
}

/** Deterministic in-memory store for unit tests (no clock, no DB). Returns deep copies so callers can't mutate internal state. */
export class InMemoryRunRecoveryStore implements RunRecoveryStore {
  private readonly rows = new Map<string, RunRecord>();

  async insert(record: RunRecord): Promise<RunRecord> {
    if (this.rows.has(record.runId)) {
      throw new Error(`run-recovery: run ${record.runId} already tracked`);
    }
    this.rows.set(record.runId, { ...record });
    return { ...record };
  }

  async get(workspaceId: string, runId: string): Promise<RunRecord | null> {
    const row = this.rows.get(runId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return { ...row };
  }

  async getByRunId(runId: string): Promise<RunRecord | null> {
    const row = this.rows.get(runId);
    return row ? { ...row } : null;
  }

  async patch(runId: string, patch: RunRecordPatch): Promise<RunRecord | null> {
    const row = this.rows.get(runId);
    if (!row) return null;
    const updated: RunRecord = { ...row, ...patch };
    this.rows.set(runId, updated);
    return { ...updated };
  }

  async listOrphaned(liveInstanceId: string): Promise<RunRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "running" && r.ownerInstanceId !== liveInstanceId)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || (a.runId < b.runId ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  async listByWorkspace(workspaceId: string): Promise<RunRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.startedAtMs - a.startedAtMs || (a.runId < b.runId ? 1 : -1))
      .map((r) => ({ ...r }));
  }
}
