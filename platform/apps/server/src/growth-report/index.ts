/**
 * Weekly growth report (issue #620) — module barrel: import everything from here.
 *
 * The problem #620 fixes: there is no periodic synthesis of what worked and what to do next. The shape of the
 * fix in code, end to end:
 *
 *   1. The data source supplies a week's metrics + experiments   (source.ts — FakeGrowthDataSource by default)
 *   2. The pure core synthesizes them into a report:             synthesizeWeeklyReport(data) → WeeklyReport
 *      — metrics with movement, wins, and ranked, data-backed recommended next bets.
 *   3. The service generates + persists it (manual or weekly):   service.ts → store.ts
 *   4. Render it for a human / agent:                            renderReport(report) → string[]
 *
 * NOTE: this barrel intentionally does **not** re-export `./default.js`. That module imports the Postgres
 * pool (`getPool`), so re-exporting it here would drag a DB dependency into every consumer of the pure
 * library (and its tests). Import the production binding directly from `growth-report/default.js` at the
 * (deliberately deferred) app-wiring site. Same parallel-merge-safe shape as #585/#588.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./synthesize.js";
export * from "./source.js";
export * from "./store.js";
export * from "./service.js";

import { formatPct } from "./synthesize.js";
import type { WeeklyReport } from "./types.js";

/**
 * Render a {@link WeeklyReport} as human-readable lines: the headline, the metric movements, the wins, and
 * the recommended next bets with their data-backed rationale. This is the "what happened and what to do
 * next" answer in plain text — for a CLI, an email digest, or the analyst agent's own reasoning trace.
 */
export function renderReport(report: WeeklyReport): string[] {
  const lines: string[] = [report.headline, ""];

  lines.push("Metrics:");
  for (const m of report.metrics) {
    const move = m.deltaPct !== null ? formatPct(m.deltaPct) : `${m.priorValue} → ${m.value}`;
    const flag = m.improved ? "✅" : m.direction === "flat" ? "—" : "⚠️";
    lines.push(`  ${flag} ${m.label}: ${m.value}${m.unit === "%" ? "%" : ""} (${move})`);
  }

  lines.push("", "Wins:");
  if (report.wins.length === 0) lines.push("  (none this week)");
  for (const w of report.wins) lines.push(`  • ${w.headline} — ${w.detail}`);

  lines.push("", "Recommended next bets:");
  report.nextBets.forEach((b, i) => {
    lines.push(`  ${i + 1}. [${b.priority}] ${b.action}`);
    lines.push(`     ${b.rationale}`);
  });

  return lines;
}
