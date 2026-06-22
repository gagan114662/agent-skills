/**
 * Daily agent standup digest (issue #589) — module barrel: import everything from here.
 *
 * The problem #589 fixes: the user can't tell at a glance what the team accomplished or where it's stuck. The
 * shape of the fix in code, end to end:
 *
 *   1. The data source supplies a day's per-agent activity   (source.ts — FakeDailyActivitySource by default)
 *   2. The pure core synthesizes it into a digest:           synthesizeDailyDigest(data) → DailyDigest
 *      — grouped by agent, with what-they-did + what's-next, blockers surfaced, and working receipt links.
 *   3. The service generates + persists it (manual or daily): service.ts → store.ts
 *   4. Render it for a human / agent:                          renderDigest(digest) → string[]
 *
 * NOTE: this barrel intentionally does **not** re-export `./default.js`. That module imports the Postgres pool
 * (`getPool`), so re-exporting it here would drag a DB dependency into every consumer of the pure library (and
 * its tests). Import the production binding directly from `standup-digest/default.js` at the (deliberately
 * deferred) app-wiring site. Same parallel-merge-safe shape as #585/#588/#620.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./synthesize.js";
export * from "./source.js";
export * from "./store.js";
export * from "./service.js";

import type { AgentStandup, DailyDigest } from "./types.js";

const STATUS_ICON: Record<AgentStandup["status"], string> = {
  shipping: "🚀",
  blocked: "⛔",
  planning: "📋",
  idle: "💤",
};

/**
 * Render a {@link DailyDigest} as human-readable lines: the headline, then a section per agent (status,
 * one-line summary, what they shipped, decisions, blockers, what's next) with the receipt link beside each
 * entry. This is the "what each agent did + what's next" answer in plain text — for a CLI, an email digest, or
 * the founder console — so nobody has to read raw logs.
 */
export function renderDigest(digest: DailyDigest): string[] {
  const lines: string[] = [digest.headline, ""];

  if (digest.agents.length === 0) {
    lines.push("(no agents reported activity)");
    return lines;
  }

  const linkSuffix = (label: string, url?: string): string => (url ? `  [${label}: ${url}]` : "");

  for (const a of digest.agents) {
    const role = a.role ? ` (${a.role})` : "";
    lines.push(`${STATUS_ICON[a.status]} ${a.agentName}${role} — ${a.status}`);
    lines.push(`  ${a.summary}`);

    if (a.shipped.length > 0) {
      lines.push("  Shipped:");
      for (const s of a.shipped) lines.push(`    • ${s.title}${linkSuffix(s.receipt?.label ?? "link", s.receipt?.url)}`);
    }
    if (a.decisions.length > 0) {
      lines.push("  Decisions:");
      for (const d of a.decisions) lines.push(`    • ${d.summary}${linkSuffix(d.receipt?.label ?? "link", d.receipt?.url)}`);
    }
    if (a.blockers.length > 0) {
      lines.push("  Blockers:");
      for (const b of a.blockers) {
        lines.push(`    • [${b.severity ?? "medium"}] ${b.summary}${linkSuffix(b.receipt?.label ?? "link", b.receipt?.url)}`);
      }
    }
    if (a.next.length > 0) {
      lines.push("  Next:");
      for (const p of a.next) lines.push(`    • ${p.summary}${linkSuffix(p.receipt?.label ?? "link", p.receipt?.url)}`);
    }
    lines.push("");
  }

  return lines;
}
