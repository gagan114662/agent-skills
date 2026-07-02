/**
 * Turn a {@link ScoredCampaign} into filed-gap drafts (#dogfood-harness). Pure. The mission requires every
 * place the fleet "failed, was generic, broke voice, or needed a human" to become a GitHub issue with
 * evidence. This maps the rubric's structured output into deduped issue drafts; the harness adds the
 * operational gaps it discovers (blocked agent spawn, unwired Lens grader) and files them under review.
 *
 * #200: asset text that appears in evidence is untrusted DATA — it is quoted, never executed, and the harness
 * that publishes these drafts holds the create-issue action behind its own review/approval.
 */
import type { ScoredCampaign } from "./types.js";

/** A gap ready to become a GitHub issue. `fingerprint` dedupes re-runs of the same gap. */
export interface GapDraft {
  title: string;
  body: string;
  labels: string[];
  fingerprint: string;
}

const LABELS = ["dogfood", "campaign-rubric", "gap"];

function fp(parts: string[]): string {
  return `dogfood-campaign:${parts.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join(":")}`.slice(0, 120);
}

/** Derive campaign-level gap drafts: coverage shortfalls, spec-invalid assets, and below-bar assets. */
export function deriveGapDrafts(scored: ScoredCampaign, runId: string): GapDraft[] {
  const drafts: GapDraft[] = [];

  for (const g of scored.coverageGaps) {
    drafts.push({
      title: `Dogfood gap: campaign missing required asset — ${g.kind}`,
      body: [
        `## Observation`,
        `The dogfood campaign run \`${runId}\` did not produce the required **${g.kind}** asset (need ${g.required}, have ${g.present}).`,
        ``,
        `## Expected`,
        `A complete award-grade campaign ships every mandated asset type. A missing kind means the fleet either can't produce it or dropped it silently.`,
        ``,
        `## Acceptance`,
        `- The fleet produces ${g.required}× \`${g.kind}\` from the brief, or the run names the specific blocked capability and routes it to review.`,
        `- A regression fixture covers this coverage gap.`,
      ].join("\n"),
      labels: LABELS,
      fingerprint: fp(["coverage", g.kind]),
    });
  }

  const specInvalid = scored.assets.filter((a) => a.specViolations.some((v) => v.severity === "error"));
  for (const a of specInvalid) {
    const errs = a.specViolations.filter((v) => v.severity === "error");
    drafts.push({
      title: `Dogfood gap: spec-invalid ${a.kind} — "${a.title}"`,
      body: [
        `## Observation`,
        `Asset **${a.title}** (${a.kind}) is spec-invalid and cannot run on its channel.`,
        ``,
        `## Evidence`,
        ...errs.map((v) => `- \`${v.rule}\`: ${v.message}`),
        ``,
        `## Expected`,
        `Every asset the fleet ships must satisfy its channel's hard spec (char limits, required fields). Spec errors mean an ad platform or client would reject it outright.`,
        ``,
        `## Acceptance`,
        `- The asset is regenerated within spec.`,
        `- The generator enforces the channel spec so this can't recur.`,
      ].join("\n"),
      labels: LABELS,
      fingerprint: fp(["spec", a.kind, a.title]),
    });
  }

  // Below-bar but spec-valid, with a CONCRETE defect (generic voice / invented claim / a graded-low
  // dimension). Assets that are below-bar ONLY because they are ungraded are deliberately EXCLUDED here: that
  // is one root cause (no Lens grader), already filed once as an operational gap by the harness — emitting a
  // near-identical per-asset issue for every ungraded asset would be dedup-violating noise.
  const softBelow = scored.belowBar.filter(
    (a) =>
      !a.specViolations.some((v) => v.severity === "error") &&
      (a.slopHits.length > 0 || a.claimViolations.length > 0 || a.graded),
  );
  for (const a of softBelow) {
    const reasons = [
      ...a.slopHits.map((s) => `AI-slop: "${s.phrase}"`),
      ...a.claimViolations.map((c) => `unapproved claim: "${c.claim}"`),
      ...(a.graded ? [] : ["dimension(s) under the minimum"]),
    ];
    drafts.push({
      title: `Dogfood gap: ${a.kind} below award bar — "${a.title}"`,
      body: [
        `## Observation`,
        `Asset **${a.title}** (${a.kind}) scored ${a.scores.overall}/10, below the ${scored.bar} bar.`,
        `Reasons: ${reasons.join("; ") || "dimension(s) under the minimum"}.`,
        ``,
        `## Rewrite notes`,
        ...a.rewriteNotes.map((n) => `- ${n}`),
        ``,
        `## Acceptance`,
        `- The asset is rewritten to clear the bar (composite ≥ ${scored.bar}, every dimension ≥ 7), Lens-graded.`,
      ].join("\n"),
      labels: LABELS,
      fingerprint: fp(["below-bar", a.kind, a.title]),
    });
  }

  return drafts;
}
