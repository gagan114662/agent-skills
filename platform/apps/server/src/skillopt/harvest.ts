/**
 * SkillOpt-Sleep transcript harvest (#283, ADR-0283 — Follow-up #1) — **pure**: reduce the real, persisted
 * record of what a department agent kept being asked to do into the loop's {@link TranscriptSample} inputs.
 *
 * The source of truth is the `marketing_tasks` table (#123): every welcome/@mention brief a department agent
 * ran is recorded there with its objective text and its terminal status. That is the loop's "harvest its own
 * session transcripts" surface — already audited, workspace-scoped, and produced by real fleet runs (not the
 * agent's self-report). This module turns those rows into sanitized samples; the IO (the bounded DB read) is
 * the seam in `default.ts`, so this stays dependency-free and unit-testable.
 *
 * Premortem (#200) is honored here, at the ingest boundary:
 *   - §6 injection defense — the brief text is **DATA**: it is run through {@link sanitizeForData} (control
 *     chars stripped, whitespace collapsed, length capped) before it is ever carried as a sample. Nothing
 *     here executes the text; downstream mining clusters it structurally.
 *   - §2 self-reported metrics are fiction — the row's terminal status becomes the sample's `succeeded` flag,
 *     which the loop uses ONLY as a mining weight, never as a quality metric. Quality is judged exclusively
 *     by external receipts in the adoption gate. A row that merely reached `done` cannot, by itself, move a
 *     skill doc.
 */
import type { TranscriptSample } from "./contract.js";
import { sanitizeForData } from "./mine.js";

/**
 * The structural subset of a `marketing_tasks` row the harvest needs. Declared here (not imported from the
 * repo) so this module stays pure/dependency-free — `default.ts` maps real rows onto this shape.
 */
export interface HarvestableTaskRecord {
  /** Stable row id (becomes the sample id for traceability; never surfaced as an instruction). */
  id: string;
  workspaceId: string;
  /** The department key the task ran under (e.g. `seo`). Used to confirm the row belongs to this agent. */
  department: string;
  /** The objective the agent was briefed with — DATA, sanitized before use. */
  task: string;
  /** The task's terminal status (`done` ⇒ the session reached a successful end). */
  status: string;
}

/** Options for {@link reduceMarketingTasksToSamples}. Defaults keep the harvested batch bounded. */
export interface HarvestOptions {
  /**
   * Max samples to emit (newest-first inputs are assumed; the excess tail is dropped). Bounds the loop's
   * blast radius so one noisy workspace can never flood mining. Default 200.
   */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 200;

/** True iff a `marketing_tasks` terminal status means the session ended successfully (a mining weight only). */
export function taskStatusSucceeded(status: string): boolean {
  return status === "done";
}

/**
 * Reduce a batch of `marketing_tasks` rows for ONE department agent into sanitized {@link TranscriptSample}s.
 *
 * Each row that belongs to `department` and carries a non-empty objective becomes one sample: the objective
 * is sanitized to DATA, the row id is the sample id, and `succeeded` is derived from the terminal status. A
 * row for a different department, or one whose objective sanitizes to empty (e.g. all control chars), is
 * dropped. The result is capped at `maxSamples`. Pure + total ⇒ unit-testable; the bounded DB read is the
 * caller's seam.
 */
export function reduceMarketingTasksToSamples(
  rows: readonly HarvestableTaskRecord[],
  agentHandle: string,
  department: string,
  opts: HarvestOptions = {},
): TranscriptSample[] {
  const maxSamples = opts.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const out: TranscriptSample[] = [];
  for (const row of rows) {
    if (out.length >= maxSamples) break;
    if (row.department !== department) continue; // belongs to a different agent — never cross the streams
    const taskText = sanitizeForData(row.task);
    if (taskText.length === 0) continue; // nothing minable (e.g. an objective that was all control chars)
    out.push({
      sampleId: row.id,
      workspaceId: row.workspaceId,
      agentHandle,
      taskText,
      succeeded: taskStatusSucceeded(row.status),
    });
  }
  return out;
}
