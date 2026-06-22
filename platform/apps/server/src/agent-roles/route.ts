/**
 * Pure task → role routing (issue #586). Given a {@link RoutingTask} and a {@link RoleRegistry}, decide
 * which role should own the task and *why*. No IO, no clock, no global state — the same task always routes
 * the same way, and every decision carries the reasons that produced it (the #611 "show your factors"
 * convention) so a mis-route is debuggable rather than mysterious.
 *
 * Scoring, highest signal first:
 *   1. capability filter  — a role that is not allowed *every* tool in `task.requiredTools` is disqualified
 *                           (scores 0, eligible=false). This is what keeps a task off a role outside whose
 *                           scope the work falls.
 *   2. explicit kind      — each eligible role that owns `task.kind` gets {@link KIND_WEIGHT}. An explicit
 *                           kind is the strongest, text-independent signal.
 *   3. keyword overlap    — +1 per distinct role keyword found as a whole word in the task text.
 *
 * The winner is the highest-scoring eligible role; ties break by roster order (deterministic). When no
 * eligible role scores above zero the decision is `role: null` — an honest "nothing matched" rather than a
 * silent hand-off to whoever happened to sort first.
 */

import type { RoleRegistry } from "./registry.js";
import type {
  AgentRole,
  RoleDefinition,
  RoleScore,
  RoutingConfidence,
  RoutingDecision,
  RoutingTask,
} from "./types.js";

/** Points awarded to a role that owns the task's explicit kind. Outweighs any plausible keyword overlap. */
export const KIND_WEIGHT = 10;

/** Points per distinct matched keyword. */
export const KEYWORD_WEIGHT = 1;

/** Split text into lowercase word tokens (alphanumerics; everything else is a separator). */
function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g);
  return new Set(tokens ?? []);
}

/** The keywords of `def` that appear as whole words in `tokens`, in the role's declared order. */
function matchKeywords(def: RoleDefinition, tokens: Set<string>): string[] {
  return def.keywords.filter((kw) => tokens.has(kw));
}

/**
 * Derive a confidence band from the winning score and its margin over the runner-up. A clear winner is
 * `high`; a narrow win (margin of one keyword) is `medium`; a weak, keyword-only signal is `low`.
 */
function confidenceFor(top: number, runnerUp: number): RoutingConfidence {
  if (top <= 0) return "none";
  if (top >= KIND_WEIGHT && top - runnerUp >= KIND_WEIGHT) return "high";
  if (top - runnerUp >= 2) return "high";
  if (top - runnerUp >= 1) return "medium";
  return "low";
}

/**
 * Route `task` to a role using `registry`. Returns a fully-explained {@link RoutingDecision}: the chosen
 * role (or `null`), a confidence band, every candidate scored best-first, and a one-sentence rationale.
 */
export function routeTask(task: RoutingTask, registry: RoleRegistry): RoutingDecision {
  const required = task.requiredTools ?? [];
  const tokens = tokenize(task.description);

  const scores: RoleScore[] = registry.list().map((def) => {
    const reasons: string[] = [];

    // 1. Capability filter — disqualify a role missing any required tool.
    const missingTools = required.filter((tool) => !def.allowedTools.includes(tool));
    if (missingTools.length > 0) {
      reasons.push(`not allowed required tool(s): ${missingTools.join(", ")}`);
      return { role: def.id, score: 0, eligible: false, reasons, matchedKeywords: [] };
    }

    let score = 0;

    // 2. Explicit kind match.
    if (task.kind !== undefined && def.handlesTaskKinds.includes(task.kind)) {
      score += KIND_WEIGHT;
      reasons.push(`owns task kind "${task.kind}" (+${KIND_WEIGHT})`);
    }

    // 3. Keyword overlap.
    const matchedKeywords = matchKeywords(def, tokens);
    if (matchedKeywords.length > 0) {
      score += matchedKeywords.length * KEYWORD_WEIGHT;
      reasons.push(`matched keyword(s): ${matchedKeywords.join(", ")} (+${matchedKeywords.length * KEYWORD_WEIGHT})`);
    }

    if (score === 0) reasons.push("no matching kind or keywords");

    return { role: def.id, score, eligible: true, reasons, matchedKeywords };
  });

  // Sort best-first; ties broken by roster order so the result is deterministic.
  const order = new Map<AgentRole, number>(registry.roleIds().map((id, i) => [id, i]));
  const ranked = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (order.get(a.role) ?? 0) - (order.get(b.role) ?? 0);
  });

  const top = ranked[0];
  const runnerUp = ranked[1];
  const topScore = top && top.eligible ? top.score : 0;
  const runnerUpScore = runnerUp && runnerUp.eligible ? runnerUp.score : 0;

  if (!top || topScore <= 0) {
    const rationale =
      required.length > 0 && ranked.every((s) => !s.eligible)
        ? `No role is allowed the required tool(s): ${required.join(", ")}.`
        : "No role matched the task by kind or keywords; needs explicit routing.";
    return { role: null, confidence: "none", ranked, rationale };
  }

  const confidence = confidenceFor(topScore, runnerUpScore);
  const rationale = `Routed to ${top.role} (score ${topScore}, ${confidence} confidence): ${top.reasons.join("; ")}.`;
  return { role: top.role, confidence, ranked, rationale };
}
