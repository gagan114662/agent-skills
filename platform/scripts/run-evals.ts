#!/usr/bin/env tsx
/**
 * run-evals.ts (#155, ADR-0155 §4) — the offline eval gate + before/after delta for CI.
 *
 * Runs every agent's offline eval suite through the SAME deterministic, model-free answerer the server
 * uses (the real semantic layer for metric questions over a fixed governed fixture; skill-file invariants
 * for discipline questions), compares each agent against the committed baseline
 * (`platform/agents/evals/baseline.json`), prints a markdown delta table for the PR description, and writes
 * `platform/.eval-report.json`. Exits non-zero if any agent regressed beyond tolerance — the maintenance
 * latch the Anthropic playbook calls for (skills drift 95% → 65% silently without it).
 *
 * No DB, no network, no model spend. Run: `pnpm --filter @reload/server tsx ../../scripts/run-evals.ts`
 * (a thin `evals` package script wraps it).
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSuiteAgents,
  loadSuite,
  loadSkillText,
  loadBaseline,
} from "../apps/server/src/evals/loader.js";
import { runSuiteCases, type AnswerContext } from "../apps/server/src/evals/corpus.js";
import { summarizeRun, compareRuns, verdictRow } from "../apps/server/src/evals/regression.js";
import { offlineResolve } from "../apps/server/src/evals/fixture.js";

const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Deterministic governed fixture keyed off the catalog `scope`, so the offline verdict matches what the
// live server gives over an empty workspace (workspace metrics → semantic_layer; venture metrics → flagged
// raw fallback). Offline + model-free by construction.
const NOW = 1_700_000_000_000;
const ctx: AnswerContext = {
  nowMs: NOW,
  maxAgeMs: 24 * 3_600_000,
  resolve: (id) => offlineResolve(id, NOW),
  skillText: (agent) => loadSkillText(agent),
};

function main(): void {
  const baseline = loadBaseline();
  const tolerance = baseline.tolerance ?? 0;
  const agents = listSuiteAgents();

  const rows: string[] = [];
  const report: Record<string, unknown>[] = [];
  let regressedAny = false;
  let totalCases = 0;
  let totalPassed = 0;

  for (const agent of agents) {
    const suite = loadSuite(agent);
    const summary = summarizeRun(agent, suite.version, runSuiteCases(suite, ctx));
    const verdict = compareRuns(baseline.agents[agent], summary, tolerance);
    rows.push(verdictRow(verdict));
    report.push({
      agent,
      version: suite.version,
      total: summary.total,
      passed: summary.passed,
      passRate: summary.passRate,
      baselineRate: verdict.baselineRate,
      delta: verdict.delta,
      regressed: verdict.regressed,
      failedCases: summary.results.filter((r) => !r.passed).map((r) => r.caseId),
    });
    totalCases += summary.total;
    totalPassed += summary.passed;
    if (verdict.regressed) regressedAny = true;
  }

  const overall = totalCases > 0 ? totalPassed / totalCases : 0;

  // Markdown delta for the PR description.
  console.log("## Fleet eval delta (#155)\n");
  console.log(`Offline, model-free suites · ${agents.length} agents · ${totalCases} cases · **${(overall * 100).toFixed(1)}%** overall\n`);
  console.log("| agent | baseline | current | delta | |");
  console.log("|---|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log("");

  writeFileSync(
    resolve(PLATFORM_ROOT, ".eval-report.json"),
    JSON.stringify({ overall, totalCases, totalPassed, tolerance, agents: report }, null, 2) + "\n",
  );

  if (regressedAny) {
    console.error("\nEval regression detected — a skill drifted below baseline. Update the skill/eval in this PR.");
    process.exit(1);
  }
  console.log("All agents held or beat baseline. ✅");
}

main();
