/**
 * Shared types for the Self-QA Loop (#171, ADR-0171). The pure `catalog`/`classify`/`fingerprint`/
 * `render` modules and the IO `runner`/`bridge`/`engine` agree on these — the same pure-core / IO-seam
 * split as the #117 flywheel and #105 watchdog (a raw check result in, a structured finding out).
 */

/** How bad a failed check is. Drives the severity label, the smoke subset, and owner paging. */
export const QA_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];

/**
 * The product surface a check exercises — the grouping a human QA (and the owner's report) uses.
 * Bounded + stable: it is part of the dedup signature and a low-cardinality issue label.
 */
export const QA_SURFACES = [
  "auth",
  "channels",
  "composer",
  "automations",
  "approvals",
  "navigation",
  "sessions",
  "layout",
] as const;
export type QaSurface = (typeof QA_SURFACES)[number];

/** The two run sizes: `smoke` (fast, post-deploy) ⊂ `full` (nightly). */
export const QA_SUITES = ["smoke", "full"] as const;
export type QaSuite = (typeof QA_SUITES)[number];

/** One entry in the QA catalog — a single thing a human QA would check, encoded as pure data. */
export interface QaCheck {
  /** Stable, unique id (also the dedup key together with the surface). */
  id: string;
  surface: QaSurface;
  /** Which suites run this check. `smoke` checks also run in `full`. */
  suites: QaSuite[];
  /** Human-readable headline (the issue title). */
  title: string;
  /** The numbered repro a human would follow — copied verbatim onto the finding + issue body. */
  steps: string[];
  /** What a passing run should observe. */
  expectation: string;
  /** Severity if this check fails. */
  severityOnFail: QaSeverity;
}

/** The driver's raw output for one check — did it pass, and (on failure) what was actually observed. */
export interface RawCheckResult {
  checkId: string;
  ok: boolean;
  /** On failure: the observed value/error (free-form; normalized before it reaches an issue). */
  actual?: string;
  /** On failure: a scrubbed evidence/screenshot path (never a token-bearing URL). */
  evidencePath?: string;
}

/** A classified bug finding — the structured event the issue/flywheel are rendered from. */
export interface QaFinding {
  checkId: string;
  surface: QaSurface;
  severity: QaSeverity;
  title: string;
  /** The repro steps (from the catalog). */
  steps: string[];
  expected: string;
  /** The observed failure detail (free-form). */
  actual: string;
  evidencePath?: string;
  /** The stable 16-hex dedup signature (one per broken check). */
  signature: string;
}

/** The per-run rollup persisted into `selfqa_runs` and printed by the CLI. */
export interface QaRunSummary {
  suite: QaSuite;
  target: string;
  checksTotal: number;
  checksFailed: number;
  criticalCount: number;
}
