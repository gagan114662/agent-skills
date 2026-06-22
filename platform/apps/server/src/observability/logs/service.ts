/**
 * Durable run-log + failing-tool service (issues #665/#666) — the one door that writes a run's log lines and
 * failure record, redacting at the boundary so a secret can never be persisted (the #25/#200 rule the #560
 * trace also enforces). Pure orchestration over an injected {@link LogStore} seam, exactly like the #560
 * `TraceService` and the #670 budget service: unit-tested with the in-memory store, bound to the real
 * self-managed Postgres store in `logs/default.ts`.
 *
 * #665: lines go to durable storage (not an in-memory buffer that dies on restart) and are read back for the
 *       trace view; {@link RunLogService.pruneByRetention} enforces a retention window.
 * #666: {@link RunLogService.recordToolFailure} pins the exact failing tool call (name + redacted args +
 *       error) onto the run, and {@link RunLogService.getFailure} surfaces it — a failed run names what broke.
 *
 * Every method is workspace-scoped (#3 IDOR): a run's logs/failure are only ever reachable through the
 * workspace that owns them.
 */

import { redactLogLine, redactToolArgs } from "./redact.js";
import type { LogStore, PersistLineInput } from "./store.js";
import type {
  AppendLineInput,
  LogQuery,
  RecordFailureInput,
  RunFailure,
  RunLog,
  RunLogLine,
} from "./types.js";

/** Retention default (days) for the durable run log, overridable via env. */
export function resolveRetentionDays(): number {
  const raw = process.env.OBSERVABILITY_LOG_RETENTION_DAYS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

const MS_PER_DAY = 86_400_000;

export class RunLogService {
  private readonly now: () => Date;

  constructor(
    private readonly store: LogStore,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Persist run-log lines durably. Each line's text is redacted (known secret values scrubbed, length
   * capped) before it lands, so the log survives a restart without ever holding a raw secret. Returns the
   * persisted lines with their assigned `seq`. `secretValues` are the run's known secrets (empty ⇒ cap only).
   */
  async append(
    workspaceId: string,
    runId: string,
    lines: readonly AppendLineInput[],
    secretValues: readonly string[] = [],
  ): Promise<RunLogLine[]> {
    if (lines.length === 0) return [];
    const now = this.now();
    const rows: PersistLineInput[] = lines.map((l) => ({
      workspaceId,
      runId,
      stream: l.stream ?? "stdout",
      text: redactLogLine(l.text, secretValues),
      occurredAt: l.occurredAt ?? now,
    }));
    return this.store.appendLines(rows);
  }

  /** A run's persisted log (workspace-scoped), oldest-first, plus the next poll cursor. */
  async getLog(workspaceId: string, runId: string, query: LogQuery = {}): Promise<RunLog> {
    const lines = await this.store.listLines(workspaceId, runId, query);
    const cursor = lines.reduce((m, l) => Math.max(m, l.seq), query.afterSeq ?? 0);
    return { runId, lines, cursor };
  }

  /**
   * Record the failing tool call that sank a run (#666): the tool name, its arguments (redacted — sensitive
   * keys masked, secret values scrubbed), and the error. Upserts, so re-recording overwrites with the latest
   * failure. Returns the stored (redacted) record.
   */
  async recordToolFailure(
    workspaceId: string,
    runId: string,
    input: RecordFailureInput,
    secretValues: readonly string[] = [],
  ): Promise<RunFailure> {
    const failure: RunFailure = {
      workspaceId,
      runId,
      toolName: input.toolName,
      args: redactToolArgs(input.args ?? {}, secretValues),
      error: redactLogLine(input.error, secretValues),
      occurredAt: input.occurredAt ?? this.now(),
    };
    await this.store.recordFailure(failure);
    return failure;
  }

  /** A run's failing-tool record, or null if it succeeded / is cross-workspace. */
  getFailure(workspaceId: string, runId: string): Promise<RunFailure | null> {
    return this.store.getFailure(workspaceId, runId);
  }

  /** Delete logs + failures older than `olderThan`; returns the rows removed. */
  pruneOlderThan(olderThan: Date): Promise<number> {
    return this.store.prune(olderThan);
  }

  /** Enforce the retention window: delete everything older than `days` (default {@link resolveRetentionDays}). */
  pruneByRetention(days: number = resolveRetentionDays()): Promise<number> {
    const cutoff = new Date(this.now().getTime() - days * MS_PER_DAY);
    return this.store.prune(cutoff);
  }
}
