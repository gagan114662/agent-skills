import { slugify } from "./memory.js";
import type { OkrDrift } from "./okr.js";
import type { GoNoGo, PlanItem, VentureMemoryEntry } from "./types.js";

/**
 * The weekly planning decision (#197 AC2, ADR-0197). **Pure + unit-tested**: the service does the side
 * effects (persist the plan, enqueue the #13 gate, flow approved items into the #115 backlog); this
 * drafts next week's backlog for ONE venture from its scorecard + memory + OKR drift + open backlog +
 * candidate playbooks.
 *
 * The premortem (#200) is baked into the OUTPUT, not just the prose:
 *   - every item's `estimateLabel` is the literal `"UNVERIFIED"` (#200 mode 2 — estimates are not facts);
 *   - `goNoGo` is `"go"` ONLY when the venture has ≥ 1 externally-verified (#106) metric receipt — a
 *     self-reported scorecard score never flips it alone (#200 mode 2/3);
 *   - `premortem` cites #200 and the specific failure modes the decision answers, and `premortemCited`
 *     is always true (the drafter refuses to emit a plan that doesn't cite the standing failure list).
 */

/** A candidate playbook to apply (the #197 cross-venture learning surface). */
export interface PlanPlaybookCandidate {
  id: string;
  category: string;
  pattern: string;
}

export interface WeeklyPlanInput {
  ideaId: string;
  /** ISO week `YYYY-Www` this plan is for. */
  weekKey: string;
  /** Count of externally-verified (#106) metric receipts the venture has this period. */
  verifiedMetricCount: number;
  /** The latest adversarial #96 scorecard score, or null. Self-reported ⇒ never flips go/no-go alone. */
  selfReportedScore: number | null;
  /** The venture's OKRs with computed drift — the primary source of next-week work. */
  okrDrift: OkrDrift[];
  /** Salient venture memories (customer voice, failures to avoid). */
  memories: VentureMemoryEntry[];
  /** Candidate cross-venture playbooks to apply. */
  playbooks: PlanPlaybookCandidate[];
  /** Titles already in the #115 backlog — drafted items dedupe against these (and each other). */
  openBacklogTitles: string[];
  /** Hard cap on drafted items. */
  maxItems: number;
}

export interface PremortemCitation {
  /** Always 200 — the standing premortem issue. */
  issue: number;
  /** The #200 failure modes this go/no-go answers. */
  failureModes: number[];
  note: string;
}

export interface WeeklyPlanDraft {
  ideaId: string;
  weekKey: string;
  goNoGo: GoNoGo;
  items: PlanItem[];
  rationale: string;
  premortem: PremortemCitation;
  /** Always true — the plan structurally cites #200 (#197 honors #200 AC3). */
  premortemCited: boolean;
}

const UNVERIFIED = "UNVERIFIED" as const;

/** A plan item with a sane evidence baseline; callers override the fields they have signal for. */
function item(partial: Omit<Partial<PlanItem>, "estimateLabel"> & { title: string; why: string }): PlanItem {
  return {
    estimateLabel: UNVERIFIED,
    source: "memory",
    sourceRef: "",
    severityTier: 1,
    signalCount: 1,
    corroboratingSources: 1,
    effortPoints: 2,
    ...partial,
  };
}

/**
 * Draft the weekly plan for one venture. Items are generated deterministically in priority order and
 * deduped (by title) against the open backlog and each other, then truncated to `maxItems`:
 *
 *   1. **Unverified OKR key results** → "Instrument a verified metric for X" (top priority: you cannot
 *      steer on fiction — #200 mode 2/3). severityTier 3.
 *   2. **OKR key results that are behind** (verified) → "Close the OKR gap on X". severityTier 2.
 *   3. **Customer-voice memories** → "Address customer voice: …". severityTier 2.
 *   4. **Candidate playbooks** → "Apply playbook: …" (cross-venture learning). severityTier 1.
 */
export function decideWeeklyPlan(input: WeeklyPlanInput): WeeklyPlanDraft {
  const items: PlanItem[] = [];
  const taken = new Set(input.openBacklogTitles.map((t) => slugify(t)));
  const push = (it: PlanItem): void => {
    const key = slugify(it.title);
    if (taken.has(key)) return;
    taken.add(key);
    items.push(it);
  };

  // (1) unverified KRs — produce a real receipt before steering. Highest priority.
  for (const okr of input.okrDrift) {
    for (const kr of okr.keyResults) {
      if (kr.status === "unverified") {
        push(
          item({
            title: `Instrument a verified metric for ${kr.metric}`,
            why: `OKR "${okr.objective}" reports ${kr.metric} self-reported (${kr.current}/${kr.target}) with no external receipt — #200 mode 2 bars steering on it.`,
            source: "scorecard_gap",
            sourceRef: okr.okrId,
            severityTier: 3,
            corroboratingSources: 0,
            effortPoints: 3,
          }),
        );
      }
    }
  }

  // (2) behind, verified KRs — close the gap.
  for (const okr of input.okrDrift) {
    for (const kr of okr.keyResults) {
      if (kr.status === "behind") {
        push(
          item({
            title: `Close the OKR gap on ${kr.metric}`,
            why: `Verified ${kr.metric} at ${kr.current}/${kr.target} for "${okr.objective}" — behind pace.`,
            source: "scorecard_gap",
            sourceRef: okr.okrId,
            severityTier: 2,
            corroboratingSources: 1,
          }),
        );
      }
    }
  }

  // (3) customer-voice memories — the venture should act on what customers said.
  for (const m of input.memories.filter((x) => x.kind === "customer_voice")) {
    push(
      item({
        title: `Address customer voice: ${m.text.slice(0, 60)}`,
        why: `Recorded customer voice for the venture${m.sourceRef ? ` (${m.sourceRef})` : ""}.`,
        source: "memory",
        sourceRef: m.id,
        severityTier: 2,
      }),
    );
  }

  // (4) candidate playbooks — apply a verified pattern from a sibling venture (#197 cross-venture).
  for (const pb of input.playbooks) {
    push(
      item({
        title: `Apply playbook: ${pb.pattern.slice(0, 60)}`,
        why: `A verified ${pb.category} pattern from a sibling venture (anonymized provenance).`,
        source: "playbook",
        sourceRef: pb.id,
        severityTier: 1,
        signalCount: 1,
      }),
    );
  }

  const bounded = items.slice(0, Math.max(0, input.maxItems));

  // Go/no-go is gated on EXTERNALLY-VERIFIED metrics — self-reported score never flips it (premortem).
  const goNoGo: GoNoGo = input.verifiedMetricCount > 0 ? "go" : "no_go";
  const premortem: PremortemCitation =
    goNoGo === "go"
      ? {
          issue: 200,
          failureModes: [2],
          note: `${input.verifiedMetricCount} externally-verified metric receipt(s) ground this go (#200 mode 2 satisfied); estimates remain UNVERIFIED.`,
        }
      : {
          issue: 200,
          failureModes: [2, 3],
          note: "Zero externally-verified metrics — self-reported signals are fiction (#200 mode 2); the plan prioritizes producing a real receipt before any scale decision (mode 3).",
        };

  const scoreNote =
    input.selfReportedScore !== null
      ? ` Self-reported score ${input.selfReportedScore} is context only and does not drive scale alone (#200 mode 2).`
      : "";
  const rationale =
    `${goNoGo === "go" ? "GO" : "NO-GO"} per premortem #200: ${premortem.note}` + scoreNote;

  return {
    ideaId: input.ideaId,
    weekKey: input.weekKey,
    goNoGo,
    items: bounded,
    rationale,
    premortem,
    premortemCited: true,
  };
}
