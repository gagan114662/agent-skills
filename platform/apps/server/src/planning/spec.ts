import type { BacklogItemRecord, RankedBacklogItem } from "./types.js";

/**
 * The Product Planning Loop spec drafter (#115, ADR-0115). **Pure + unit-tested**: turns the top-ranked
 * backlog item into a spec in the repo lifecycle format (Objective / Why ranked here / Acceptance /
 * Non-goals), embedding the **why-ranked-here** evidence link + the RICE breakdown that earned the
 * rank. The service persists the result and proposes a build session for it.
 */

/** Format a RICE score: an integer prints bare, otherwise to two decimals. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Draft a repo-lifecycle-format spec for a backlog item, given its rank in the backlog. */
export function draftSpec(
  item: BacklogItemRecord,
  ranked: RankedBacklogItem,
): { title: string; body: string } {
  const title = `Spec: ${item.title}`;
  const { rice, score, position } = ranked;
  const pivotNote = item.isPivot
    ? "\n> **Pivot:** this item changes product direction — it requires human approval before dispatch.\n"
    : "";

  const body = `# ${title}
${pivotNote}
> Auto-drafted by the Product Planning Loop (#115) from a RICE-ranked backlog item. Source:
> \`${item.source}\` → \`${item.sourceRef || "(no ref)"}\`. Ranked **#${position}** in the backlog.

## Objective

${item.description || item.title}

This work item was sourced from **${item.source}** evidence and promoted because it is the
highest-leverage thing to build next by RICE score.

## Why ranked here

Ranked **#${position}** with a RICE score of **${fmt(score)}**:

- **Reach:** ${fmt(rice.reach)} (distinct corroborating signals)
- **Impact:** ×${fmt(rice.impact)} (severity tier ${item.impact}/4)
- **Confidence:** ${fmt(rice.confidence * 100)}% (${fmt(rice.confidence)})
- **Effort:** ${fmt(rice.effort)} point(s)

Evidence: \`${item.source}\` → \`${item.sourceRef || "(no ref)"}\`${item.ideaId ? ` (venture \`${item.ideaId}\`)` : ""}.

## Acceptance

- The behaviour described in the objective is implemented and covered by tests.
- The change ships behind the project's normal review + verification gates.
- The originating evidence (\`${item.sourceRef || "n/a"}\`) is addressed and can be re-measured.

## Non-goals

- Scope beyond the objective above — file a new backlog item instead.
`;

  return { title, body };
}
