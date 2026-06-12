import { SelfQaRunner, type SelfQaRunnerDeps, type SelfQaRunResult } from "./runner.js";
import { reportFindings, type FindingReporter } from "./bridge.js";
import type { SelfqaCaps } from "./caps.js";
import type { QaFinding, QaRunSummary, QaSuite } from "./types.js";

/**
 * The in-process Self-QA engine (#171, ADR-0171). Ties the {@link SelfQaRunner} to a {@link FindingReporter}
 * and the run-history persistence, exposing `runOnce(suite)` plus an opt-in background timer (default-off,
 * `SELFQA_INTERVAL_MS=0`) — the same supervisor shape as the #117 flywheel / #105 watchdog.
 *
 * Every side effect is a seam: resolving the synthetic workspace, persisting the run row, reporting a
 * finding, paging the owner. The engine itself only sequences them, so it is unit-tested with fakes.
 */
export interface SelfQaEngineDeps {
  runner: SelfQaRunner;
  caps: (workspaceId: string) => SelfqaCaps;
  /** The live product URL the synthetic user drives. */
  target: string;
  /** Resolve the dedicated synthetic workspace id from its reserved slug, or null if it doesn't exist. */
  resolveSyntheticWorkspaceId: (slug: string) => Promise<string | null>;
  /** The reporter for a workspace (the in-process path records into the #117 flywheel). */
  reporter: (workspaceId: string) => FindingReporter;
  /** Page the owner for a critical finding (the #148 seam). Optional + best-effort. */
  pageOwner?: (workspaceId: string, finding: QaFinding) => Promise<void>;
  /** Persist the run row (start + finish). Optional — a no-DB context can omit it. */
  persist?: {
    start(input: { workspaceId: string; suite: QaSuite; target: string }): Promise<{ id: string }>;
    finish(input: { id: string; summary: QaRunSummary }): Promise<void>;
  };
  logger: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export interface SelfQaRunOnceResult extends SelfQaRunResult {
  workspaceId: string | null;
  reported: number;
  paged: number;
}

export class SelfQaEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: SelfQaEngineDeps) {}

  /** Start the periodic full pass. No-op if interval ≤ 0 or already started (default-off). */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.runOnce("full"), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one suite end-to-end: resolve the synthetic workspace, drive the checks, report every finding,
   * page the owner for criticals, and record the run row. A missing synthetic workspace (or a disabled
   * loop) is a clean no-op — never an error.
   */
  async runOnce(suite: QaSuite): Promise<SelfQaRunOnceResult> {
    const slug = this.deps.caps("").workspaceSlug;
    const workspaceId = await this.deps.resolveSyntheticWorkspaceId(slug);
    if (!workspaceId) {
      this.deps.logger.warn({ slug }, "selfqa: synthetic workspace not found — skipping run");
      return {
        workspaceId: null,
        reported: 0,
        paged: 0,
        findings: [],
        summary: { suite, target: this.deps.target, checksTotal: 0, checksFailed: 0, criticalCount: 0 },
      };
    }

    const runRow = await this.deps.persist?.start({ workspaceId, suite, target: this.deps.target });
    const result = await this.deps.runner.run({ suite, target: this.deps.target, workspaceId });

    let reported = 0;
    let paged = 0;
    if (!result.skipped && result.findings.length > 0) {
      const out = await reportFindings(result.findings, {
        reporter: this.deps.reporter(workspaceId),
        target: this.deps.target,
        workspaceSlug: slug,
        pageOwner: this.deps.pageOwner ? (f) => this.deps.pageOwner!(workspaceId, f) : undefined,
      });
      reported = out.reported;
      paged = out.paged;
    }

    if (runRow) await this.deps.persist?.finish({ id: runRow.id, summary: result.summary });

    this.deps.logger.info(
      { workspaceId, suite, skipped: result.skipped, findings: result.findings.length, reported, paged },
      "selfqa run complete",
    );
    return { ...result, workspaceId, reported, paged };
  }
}

export { SelfQaRunner };
export type { SelfQaRunnerDeps };
