/**
 * Persistence seam for run-replay captures (issue #668). The narrow interface the service consumes: insert
 * a capture, read it back (workspace-scoped), stamp its outcome by id, list a workspace's captures, and
 * list the replays of a given original run. The production binding is the self-managed Postgres store in
 * `default.ts`; unit tests inject {@link InMemoryRunReplayStore}, so the service is tested with no database
 * (the #17 pure-decision + injected-seam pattern).
 *
 * Tenant reads (`get`, `listByWorkspace`, `listReplaysOf`) take a `workspaceId` and only ever return that
 * tenant's captures (the #3 IDOR boundary). The by-`runId` mutator (`recordOutcome`) is a system op keyed
 * by the server-issued, unguessable run id — never reachable from a tenant request.
 */

import type { CapturedRun, RunOutcome } from "./types.js";

export interface RunReplayStore {
  /** Persist a new capture. Rejects (throws) if `runId` already exists. */
  insert(capture: CapturedRun): Promise<CapturedRun>;
  /** Load one capture within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, runId: string): Promise<CapturedRun | null>;
  /** Load one capture by id (system op — used by the outcome mutator that already holds the run id). */
  getByRunId(runId: string): Promise<CapturedRun | null>;
  /**
   * Stamp a run's terminal outcome by id; returns the updated capture, or null if no such run. A no-op (no
   * row) when the run is unknown — the service decides whether that is an error.
   */
  recordOutcome(runId: string, outcome: RunOutcome, endedAtMs: number): Promise<CapturedRun | null>;
  /** A workspace's captures, newest first (#3 IDOR scoping). */
  listByWorkspace(workspaceId: string): Promise<CapturedRun[]>;
  /** The replays of a given original run, within a workspace, oldest first (#3 IDOR scoping). */
  listReplaysOf(workspaceId: string, originalRunId: string): Promise<CapturedRun[]>;
}

/** Deterministic in-memory store for unit tests (no clock, no DB). Returns deep copies so callers can't mutate internal state. */
export class InMemoryRunReplayStore implements RunReplayStore {
  private readonly rows = new Map<string, CapturedRun>();

  private clone(c: CapturedRun): CapturedRun {
    return {
      ...c,
      inputs: { ...c.inputs, config: { ...c.inputs.config }, env: { ...c.inputs.env } },
      outcome: c.outcome ? { ...c.outcome } : null,
    };
  }

  async insert(capture: CapturedRun): Promise<CapturedRun> {
    if (this.rows.has(capture.runId)) {
      throw new Error(`run-replay: run ${capture.runId} already captured`);
    }
    this.rows.set(capture.runId, this.clone(capture));
    return this.clone(capture);
  }

  async get(workspaceId: string, runId: string): Promise<CapturedRun | null> {
    const row = this.rows.get(runId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.clone(row);
  }

  async getByRunId(runId: string): Promise<CapturedRun | null> {
    const row = this.rows.get(runId);
    return row ? this.clone(row) : null;
  }

  async recordOutcome(runId: string, outcome: RunOutcome, endedAtMs: number): Promise<CapturedRun | null> {
    const row = this.rows.get(runId);
    if (!row) return null;
    const updated: CapturedRun = {
      ...row,
      status: outcome.status,
      outcome: { ...outcome },
      endedAtMs,
    };
    this.rows.set(runId, this.clone(updated));
    return this.clone(updated);
  }

  async listByWorkspace(workspaceId: string): Promise<CapturedRun[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.capturedAtMs - a.capturedAtMs || (a.runId < b.runId ? 1 : -1))
      .map((r) => this.clone(r));
  }

  async listReplaysOf(workspaceId: string, originalRunId: string): Promise<CapturedRun[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && r.replayOf === originalRunId)
      .sort((a, b) => a.capturedAtMs - b.capturedAtMs || (a.runId < b.runId ? -1 : 1))
      .map((r) => this.clone(r));
  }
}
