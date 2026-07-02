/**
 * Render a {@link ScoredCampaign} into the human-readable scored-campaign artifact (#dogfood-harness). Pure.
 * This is the primary output of a harness run: a reviewer sees the verdict, the per-asset numeric scores, the
 * coverage table, and the exact rewrite notes needed to clear the bar.
 */
import type { ScoredAsset, ScoredCampaign } from "./types.js";
import { AWARD_BAR, DIMENSION_MIN } from "./rubric.js";

function scoreLine(a: ScoredAsset): string {
  const s = a.scores;
  const mark = a.passesBar ? "PASS" : "BELOW";
  const g = a.graded ? "" : " (ungraded)";
  return `| ${a.title} | ${a.kind} | ${s.insight} | ${s.craft} | ${s.channelNativeness} | ${s.coherence} | **${s.overall}** | ${mark}${g} |`;
}

/** Render the scored campaign as Markdown. */
export function renderScoredCampaign(c: ScoredCampaign, meta?: { brief?: string; runId?: string; provenance?: string }): string {
  const lines: string[] = [];
  lines.push(`# Scored campaign artifact`);
  if (meta?.runId) lines.push(`Run: \`${meta.runId}\``);
  if (meta?.provenance) lines.push(`Asset provenance: ${meta.provenance}`);
  lines.push("");
  lines.push(`**Verdict: ${c.verdict.toUpperCase()}** — overall ${c.overall}/10 (bar ${AWARD_BAR}, every dimension ≥ ${DIMENSION_MIN}).`);
  lines.push(`Assets scored: ${c.assets.length} · below bar: ${c.belowBar.length} · fully Lens-graded: ${c.fullyGraded ? "yes" : "no"}.`);
  lines.push("");

  lines.push(`## Scores`);
  lines.push(`| Asset | Kind | Insight | Craft | Channel | Coherence | Overall | Bar |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const a of c.assets) lines.push(scoreLine(a));
  lines.push("");

  if (c.coverageGaps.length) {
    lines.push(`## Coverage gaps`);
    for (const g of c.coverageGaps) lines.push(`- Missing **${g.kind}**: need ${g.required}, have ${g.present}.`);
    lines.push("");
  }

  if (c.blockers.length) {
    lines.push(`## Blockers`);
    for (const b of c.blockers) lines.push(`- ${b}`);
    lines.push("");
  }

  const withNotes = c.assets.filter((a) => a.rewriteNotes.length);
  if (withNotes.length) {
    lines.push(`## Rewrite notes`);
    for (const a of withNotes) {
      lines.push(`### ${a.title} (${a.kind}) — overall ${a.scores.overall}`);
      for (const n of a.rewriteNotes) lines.push(`- ${n}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}
