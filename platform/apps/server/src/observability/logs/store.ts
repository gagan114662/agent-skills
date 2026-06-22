/**
 * Persistence seam for the durable run-log store (issues #665/#666). The narrow interface the service
 * consumes — append redacted log lines, read a run's lines incrementally, upsert/read a run's failing-tool
 * record, and prune everything past the retention horizon. The production binding is the self-managed
 * Postgres store in `logs/default.ts`; unit tests inject {@link InMemoryLogStore}, so the service is tested
 * with no database (the same pure-decision + injected-seam pattern as the #670 budget store).
 *
 * Everything is workspace-scoped (the `workspaceId` is part of every read filter and every row) so a caller
 * can only ever read its own tenant's logs — the #3 IDOR boundary.
 */

import type { LogQuery, LogStream, RunFailure, RunLogLine } from "./types.js";

/** A redacted line ready to persist (the service has already scrubbed `text`). */
export interface PersistLineInput {
  workspaceId: string;
  runId: string;
  stream: LogStream;
  text: string;
  occurredAt: Date;
}

export interface LogStore {
  /** Append redacted lines; returns them with their assigned `id`/`seq`, in input order. */
  appendLines(lines: PersistLineInput[]): Promise<RunLogLine[]>;
  /** A run's lines (workspace-scoped), `seq`-ordered, filtered/bounded by {@link LogQuery}. */
  listLines(workspaceId: string, runId: string, query: LogQuery): Promise<RunLogLine[]>;
  /** Upsert a run's failing-tool record (the latest failure wins). `failure` is already redacted. */
  recordFailure(failure: RunFailure): Promise<void>;
  /** A run's failing-tool record, or null if it never failed / is cross-workspace. */
  getFailure(workspaceId: string, runId: string): Promise<RunFailure | null>;
  /** Delete every line and failure older than `olderThan`; returns how many rows were removed. */
  prune(olderThan: Date): Promise<number>;
}

/** The most lines any single read returns, even if a caller asks for more. */
export const LOG_LIST_HARD_LIMIT = 5_000;

function boundLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return LOG_LIST_HARD_LIMIT;
  return Math.min(LOG_LIST_HARD_LIMIT, Math.floor(limit));
}

/**
 * In-memory {@link LogStore} for unit tests. Deterministic: `seq` is a single monotonic counter (mirroring
 * the Postgres identity column) and `id`s are derived from it, so a test never depends on a uuid or the
 * wall clock. Reads copy rows out so a caller can never mutate stored state.
 */
export class InMemoryLogStore implements LogStore {
  private readonly lines: RunLogLine[] = [];
  private readonly failures = new Map<string, RunFailure>();
  private seq = 0;

  private static key(workspaceId: string, runId: string): string {
    return `${workspaceId}:${runId}`;
  }

  async appendLines(input: PersistLineInput[]): Promise<RunLogLine[]> {
    const out: RunLogLine[] = [];
    for (const l of input) {
      const seq = ++this.seq;
      const line: RunLogLine = {
        id: `line-${seq}`,
        workspaceId: l.workspaceId,
        runId: l.runId,
        seq,
        stream: l.stream,
        text: l.text,
        occurredAt: l.occurredAt,
      };
      this.lines.push(line);
      out.push({ ...line });
    }
    return out;
  }

  async listLines(workspaceId: string, runId: string, query: LogQuery): Promise<RunLogLine[]> {
    const after = query.afterSeq ?? 0;
    return this.lines
      .filter((l) => l.workspaceId === workspaceId && l.runId === runId && l.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, boundLimit(query.limit))
      .map((l) => ({ ...l }));
  }

  async recordFailure(failure: RunFailure): Promise<void> {
    this.failures.set(InMemoryLogStore.key(failure.workspaceId, failure.runId), { ...failure });
  }

  async getFailure(workspaceId: string, runId: string): Promise<RunFailure | null> {
    const f = this.failures.get(InMemoryLogStore.key(workspaceId, runId));
    return f ? { ...f } : null;
  }

  async prune(olderThan: Date): Promise<number> {
    let removed = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i]!.occurredAt < olderThan) {
        this.lines.splice(i, 1);
        removed++;
      }
    }
    for (const [k, f] of this.failures) {
      if (f.occurredAt < olderThan) {
        this.failures.delete(k);
        removed++;
      }
    }
    return removed;
  }
}
