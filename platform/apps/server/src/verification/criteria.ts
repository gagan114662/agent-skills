import {
  type DefinitionOfDone,
  type DeliverableKind,
  type ReversibilityClass,
  type SuccessCriterion,
} from "./types.js";

/**
 * Pure "definition of done" derivation (#191 AC #1 — define done BEFORE doing). Given a deliverable kind
 * and its brief, produce a deterministic set of success criteria + the reversibility class. **No IO, no
 * clock, no randomness**: the same brief always yields the same definition, so "the work had a spec
 * before it started" is a property of the code. The IO `engine` persists it (visible in the session);
 * this file only decides what "done" means.
 */

/**
 * The reversibility floor per deliverable kind (premortem #200 §4). A class can only be TIGHTENED by a
 * hint, never loosened below the floor — an irreversible kind (a public send, a venture deploy) stays
 * irreversible regardless of what a caller passes.
 */
const REVERSIBILITY_FLOOR: Record<DeliverableKind, ReversibilityClass> = {
  // A public/external send cannot be unsent — deliverability + brand are irreversible.
  outbound_content: "irreversible",
  // A 1:1 reply can be followed up / corrected — reversible.
  support_reply: "reversible",
  // A campaign can be paused, but spend may already be incurred — cheap (reversible with some cost).
  campaign_change: "cheap",
  // A venture deploy touches money / legal / brand — irreversible.
  venture_deploy: "irreversible",
};

/** Severity order so a hint can only ever tighten the class, never loosen it below the kind's floor. */
const SEVERITY: Record<ReversibilityClass, number> = { reversible: 0, cheap: 1, irreversible: 2 };

/**
 * Classify a deliverable's reversibility. The kind sets the floor; an optional `hint` may tighten it
 * (e.g. a support reply going to a public forum → irreversible) but never loosen it.
 */
export function classifyReversibility(
  kind: DeliverableKind,
  hint?: ReversibilityClass,
): ReversibilityClass {
  const floor = REVERSIBILITY_FLOOR[kind];
  if (!hint) return floor;
  return SEVERITY[hint] > SEVERITY[floor] ? hint : floor;
}

export interface DeriveDefinitionInput {
  deliverableKind: DeliverableKind;
  /** The session brief the criteria are derived from. */
  brief: string;
  /** Optional reversibility hint (can only TIGHTEN the kind's floor). */
  reversibilityHint?: ReversibilityClass;
}

/**
 * The baseline criteria every deliverable of a kind must satisfy. Deterministic and bounded — a richer,
 * brief-aware deriver is a later seam, but the floor below is always present so the gate is never empty.
 */
const BASELINE_CRITERIA: Record<DeliverableKind, SuccessCriterion[]> = {
  outbound_content: [
    { id: "on_brief", text: "addresses the brief's goal", category: "content", required: true },
    {
      id: "originality",
      text: "is original enough to avoid copying a known source verbatim",
      category: "content",
      required: true,
    },
    { id: "brand_safe", text: "on-brand, no claims that cannot be backed", category: "content", required: true },
    { id: "no_pii_leak", text: "leaks no secrets or private data", category: "content", required: true },
  ],
  support_reply: [
    { id: "answers_question", text: "answers the customer's actual question", category: "content", required: true },
    { id: "accurate", text: "factually accurate, no invented policy", category: "content", required: true },
    { id: "tone_ok", text: "tone is appropriate and kind", category: "content", required: false },
  ],
  campaign_change: [
    { id: "intended_change", text: "makes the intended change and only that", category: "content", required: true },
    { id: "budget_bounded", text: "spend stays within the stated budget", category: "content", required: true },
    { id: "metric_real", text: "any cited metric is backed by an external receipt", category: "metric", required: true },
  ],
  venture_deploy: [
    { id: "builds_clean", text: "the build is clean and the change matches the brief", category: "content", required: true },
    { id: "deploy_live", text: "the deploy is reachable and healthy in production", category: "production", required: true },
    { id: "click_through", text: "the primary user flow works against the live deploy", category: "production", required: true },
  ],
};

/** Derive the definition of done for a deliverable (#191 AC #1). Deterministic. */
export function deriveDefinitionOfDone(input: DeriveDefinitionInput): DefinitionOfDone {
  const reversibility = classifyReversibility(input.deliverableKind, input.reversibilityHint);
  // Clone the baseline so callers can never mutate the shared template.
  const criteria = BASELINE_CRITERIA[input.deliverableKind].map((c) => ({ ...c }));
  return { deliverableKind: input.deliverableKind, reversibility, criteria };
}

/**
 * Validate a definition of done. Returns a list of human-readable problems (empty ⇒ well-formed). A
 * definition with no required criterion is rejected — a gate with nothing required is theatre.
 */
export function validateDefinitionOfDone(dod: DefinitionOfDone): string[] {
  const problems: string[] = [];
  if (dod.criteria.length === 0) problems.push("definition of done has no criteria");
  if (!dod.criteria.some((c) => c.required)) {
    problems.push("definition of done has no required criteria (the gate would be theatre)");
  }
  const ids = dod.criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) problems.push("criterion ids are not unique");
  for (const c of dod.criteria) {
    if (!c.id.trim()) problems.push("a criterion has an empty id");
    if (!c.text.trim()) problems.push(`criterion ${c.id} has empty text`);
  }
  return problems;
}
