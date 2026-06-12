import { checksForSuite } from "./catalog.js";
import { classifyResults } from "./classify.js";
import { summarize } from "./render.js";
import type { QaBrowserDriver } from "./driver.js";
import type { SelfqaCaps } from "./caps.js";
import type { QaFinding, QaRunSummary, QaSuite, RawCheckResult } from "./types.js";

/**
 * The Self-QA runner (#171, ADR-0171). Drives the synthetic-user catalog through a {@link QaBrowserDriver}
 * against the live product, classifies the failures into structured findings, and returns the run summary.
 *
 * Gating mirrors every other loop, in order (cheapest / most-protective first): maintenance pause →
 * per-workspace `enabled` flag → **synthetic-workspace guard** → kill switch → budget ceiling. The
 * synthetic-workspace guard is load-bearing: the runner REFUSES to operate on any workspace that is not
 * the dedicated, tenant-isolated synthetic one, so a misconfiguration can never drive QA against a real
 * customer's data.
 */
export interface SelfQaRunnerDeps {
  driver: QaBrowserDriver;
  caps: (workspaceId: string) => SelfqaCaps;
  /** True ONLY for the reserved synthetic QA workspace (resolved from its slug). */
  isSyntheticWorkspace: (workspaceId: string) => boolean | Promise<boolean>;
  /** The #17 kill switch for a workspace (halts the run). */
  killSwitch?: (workspaceId: string) => Promise<boolean>;
  /** The #99 maintenance pause — checked before any work. */
  maintenancePaused?: () => Promise<boolean>;
  /** The #71 dollar ceiling for the synthetic workspace (skip when exhausted). */
  budgetExhausted?: (workspaceId: string, now: Date) => Promise<boolean>;
  now?: () => Date;
}

export interface SelfQaRunInput {
  suite: QaSuite;
  target: string;
  workspaceId: string;
}

export type SelfQaSkipReason = "disabled" | "wrong_workspace" | "kill_switch" | "maintenance" | "budget";

export interface SelfQaRunResult {
  skipped?: SelfQaSkipReason;
  findings: QaFinding[];
  summary: QaRunSummary;
}

export class SelfQaRunner {
  constructor(private readonly deps: SelfQaRunnerDeps) {}

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private empty(suite: QaSuite, target: string, skipped: SelfQaSkipReason): SelfQaRunResult {
    return { skipped, findings: [], summary: { suite, target, checksTotal: 0, checksFailed: 0, criticalCount: 0 } };
  }

  async run(input: SelfQaRunInput): Promise<SelfQaRunResult> {
    const { suite, target, workspaceId } = input;

    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      return this.empty(suite, target, "maintenance");
    }

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return this.empty(suite, target, "disabled");

    // Tenant isolation: never run against anything but the dedicated synthetic workspace.
    if (!(await this.deps.isSyntheticWorkspace(workspaceId))) {
      return this.empty(suite, target, "wrong_workspace");
    }

    if (this.deps.killSwitch && (await this.deps.killSwitch(workspaceId))) {
      return this.empty(suite, target, "kill_switch");
    }

    if (this.deps.budgetExhausted && (await this.deps.budgetExhausted(workspaceId, this.clock()))) {
      return this.empty(suite, target, "budget");
    }

    const checks = checksForSuite(suite);
    const results: RawCheckResult[] = [];
    for (const check of checks) {
      try {
        results.push(await this.deps.driver.run(check, { target }));
      } catch (err) {
        // A driver crash on one check is itself a failure of that check, never an aborted run.
        results.push({ checkId: check.id, ok: false, actual: `driver error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const allFindings = classifyResults(results, checks);
    const findings = allFindings.slice(0, caps.maxFindingsPerRun);
    return { findings, summary: summarize(suite, target, results, findings) };
  }
}
