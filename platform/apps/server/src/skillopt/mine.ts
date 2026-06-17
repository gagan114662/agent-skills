/**
 * SkillOpt-Sleep task mining (#283, ADR-0283) — **pure**: turn a batch of harvested {@link TranscriptSample}
 * transcripts into the recurring tasks an agent keeps being asked to do. This is the "harvest + mine" half
 * of the offline cycle, with the premortem's injection wall baked in (#200 §6): every transcript is DATA,
 * sanitized before it is read or surfaced, and clustering is structural (normalize → group) — a poisoned
 * transcript can shift which task is "popular" but can never inject an instruction, because nothing here
 * executes the text. No IO; deterministic ⇒ unit-testable.
 */
import type { TaskCluster, TranscriptSample } from "./contract.js";

/** Hard caps so a single huge / malicious transcript can never blow up the loop (bounded blast radius). */
const MAX_TASK_LENGTH = 400;

/**
 * Strip the text down to safe DATA: drop control chars (the injection vector that smuggles ANSI / tool
 * directives), collapse whitespace, and cap the length. The result is only ever used as a clustering key
 * or a display exemplar — never as an instruction. Pure + total.
 */
export function sanitizeForData(raw: string, maxLength: number = MAX_TASK_LENGTH): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0/C1 control chars (incl. NUL, ESC, newlines) — replaced with a single space below.
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Normalize a task into its clustering key: lowercase, strip the volatile tokens that make two instances of
 * the same task look different (urls, emails, numbers, punctuation), and collapse whitespace. Two briefs
 * that are "the same task about a different page/number" collapse to one key. Pure + total.
 */
export function normalizeTaskText(raw: string): string {
  return sanitizeForData(raw)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ") // urls
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, " ") // emails
    .replace(/\d+/g, " ") // numbers (page 5 vs page 9 = same task)
    .replace(/[^a-z\s]/g, " ") // any remaining punctuation/symbols
    .replace(/\s+/g, " ")
    .trim();
}

/** Options for {@link mineRecurringTasks}. Defaults are conservative: a "recurring" task recurs ≥ 3 times. */
export interface MineOptions {
  /** Minimum occurrences for a cluster to count as recurring (default 3). */
  minRecurrence?: number;
  /** Max clusters returned (the cycle only acts on the top one; default 10). Bounds the surface. */
  maxClusters?: number;
}

/**
 * Mine the recurring tasks for ONE agent from its harvested transcripts. Filters to the given handle (so a
 * batch can mix agents safely), normalizes every task to a key, groups, keeps clusters that recur at least
 * `minRecurrence` times, and returns them most-frequent first (ties broken by key for determinism). An
 * empty or all-unique batch returns `[]` (the cycle then skips — nothing to improve). Pure.
 */
export function mineRecurringTasks(
  samples: readonly TranscriptSample[],
  agentHandle: string,
  opts: MineOptions = {},
): TaskCluster[] {
  const minRecurrence = opts.minRecurrence ?? 3;
  const maxClusters = opts.maxClusters ?? 10;

  const byKey = new Map<string, { representativeTask: string; count: number; sampleIds: string[] }>();
  for (const s of samples) {
    if (s.agentHandle !== agentHandle) continue;
    const key = normalizeTaskText(s.taskText);
    if (key.length === 0) continue; // nothing minable (e.g. a transcript that was all control chars)
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.sampleIds.push(s.sampleId);
    } else {
      byKey.set(key, { representativeTask: sanitizeForData(s.taskText), count: 1, sampleIds: [s.sampleId] });
    }
  }

  return [...byKey.entries()]
    .filter(([, v]) => v.count >= minRecurrence)
    .map(([key, v]) => ({ key, representativeTask: v.representativeTask, count: v.count, sampleIds: v.sampleIds }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, maxClusters);
}
