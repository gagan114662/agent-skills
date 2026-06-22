/**
 * Durable run logs (issue #665) + failing-tool-call surfacing (issue #666).
 *
 * Persists an agent run's output lines to durable storage with a retention window (so a run's log survives a
 * server restart, unlike the runtime's in-memory line buffer), and pins the exact failing tool call — name,
 * redacted args, and error — onto the run's failure state (so a failed run names what broke). Self-contained
 * and migration-free: it owns its own tables (lazy `CREATE TABLE IF NOT EXISTS`) and carries env-only config.
 * Lines and args are redacted at the write door, so a persisted log can never hold a raw secret. The read
 * surface is wired into the already-registered traces routes.
 */

export type {
  AppendLineInput,
  FailingToolCall,
  LogQuery,
  LogStream,
  RecordFailureInput,
  RunFailure,
  RunLog,
  RunLogLine,
} from "./types.js";

export { LOG_LINE_MAX, redactLogLine, redactToolArgs } from "./redact.js";

export {
  InMemoryLogStore,
  LOG_LIST_HARD_LIMIT,
  type LogStore,
  type PersistLineInput,
} from "./store.js";

export { RunLogService, resolveRetentionDays } from "./service.js";

export { PgLogStore, createDefaultRunLogService } from "./default.js";
