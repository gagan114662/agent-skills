/**
 * Pure markdown renderer for the AI-investigation note (#148, ADR-0148). The coordinator posts this to
 * the `#incident-NNN` channel and stores it on the overlay row (`investigation_note`). It is a sibling
 * of `sre/postmortem.ts`'s renderer: data in, markdown out, no IO. The advisory framing ("suggestions
 * only", "approval gates intact") is part of the rendered contract.
 */
import type { Confidence, InvestigationNote } from "./correlate.js";

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  high: "🔴 high",
  medium: "🟠 medium",
  low: "🟡 low",
};

export function renderInvestigationNote(note: InvestigationNote): string {
  const lines: string[] = [];
  lines.push("## 🔎 AI investigation");
  lines.push("");
  lines.push(`**Likely cause:** ${note.summary}`);
  lines.push("");

  if (note.likelyCauses.length > 0) {
    lines.push("### Correlated signals");
    for (const c of note.likelyCauses) {
      lines.push(`- **${CONFIDENCE_BADGE[c.confidence]}** — ${c.detail}`);
    }
    lines.push("");
  }

  lines.push("### Suggested next steps (advisory — not actions)");
  note.nextSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");
  lines.push(
    "> Suggestions only. The investigation reads signals; it never remediates. Fixes flow through the " +
      "flywheel → issue → agent path with #13 approval gates intact.",
  );

  return lines.join("\n");
}
