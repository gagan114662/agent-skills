import type { AngleHook, BuyerBrief, PublicSourceKind, ReadResult, TargetAccount } from "./types.js";
import type { BuyerResolution } from "./resolve.js";

/**
 * Pure buyer-brief assembly (#223, ADR-0223). Turns the resolved buyer + the quarantined read results into
 * the structured brief. No IO.
 *
 * CRITICAL invariants (#200 premortem injection defense):
 *  1. A hook is kept ONLY if it cites a source that was **actually read** (`ReadResult.ok === true`). A
 *     hook whose source was not read (missing / `ok: false`) is REJECTED — the video's "did you read the
 *     LinkedIn post?" gate. A generic, source-less hook never makes it into the brief.
 *  2. Read text is DATA: it is quoted into `evidence` and never parsed for instructions, never used to
 *     pick the buyer or write the rationale. A poisoned post cannot change who / what / why — and there is
 *     no action path here for it to reach at all.
 */

/** The brief carries the video's "2–3 angle hooks". */
export const MAX_HOOKS = 3;

/** A candidate hook proposed for the brief, before grounding is enforced. */
export interface CandidateHook {
  /** The source this hook claims to be grounded in (must have been actually read to survive). */
  sourceId: string;
  /** The angle/opener — templated from structured fields, never copied from source instruction text. */
  angle: string;
}

/** Angle templates per source kind — structured, brand-neutral openers. The topic comes from a safe tag. */
function angleFor(kind: PublicSourceKind, topic: string | undefined): string {
  const t = topic && topic.length > 0 ? topic : "their recent work";
  switch (kind) {
    case "linkedin_post":
      return `Open on their recent LinkedIn post about ${t}, then connect it to the outcome we drive.`;
    case "linkedin_profile":
      return `Reference what their profile shows they own around ${t}, and tie it to the problem we solve.`;
    case "blog":
      return `Lead with a point from their post on ${t}, showing we actually read it.`;
    case "press":
      return `Anchor on the press moment about ${t} and what it implies for their roadmap.`;
    case "conference_talk":
      return `Reference their talk on ${t} and the stance they took on it.`;
    case "other":
      return `Reference what they said publicly about ${t}.`;
  }
}

/**
 * Build one candidate hook per **successfully-read** source — the angle is templated from structured
 * fields (source kind + the first safe topic tag) only. Sources that were not read produce no candidate,
 * so the grounding invariant holds by construction (and {@link assembleBrief} re-checks it defensively).
 */
export function candidateHooksFromReads(reads: readonly ReadResult[]): CandidateHook[] {
  return reads
    .filter((r) => r.ok)
    .map((r) => ({ sourceId: r.sourceId, angle: angleFor(r.kind, r.signals[0]) }));
}

/** Dedupe + cap the topic tags from every actually-read source into the brief's "cares about". */
function caresAboutFrom(reads: readonly ReadResult[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of reads) {
    if (!r.ok) continue;
    for (const s of r.signals) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/**
 * Assemble the buyer brief. `candidateHooks` are filtered to those whose source was actually read; at most
 * `maxHooks` survive. The buyer, role, and rationale come straight from the pure {@link BuyerResolution} —
 * never from the read text — so enrichment can enrich but can never steer the decision.
 */
export function assembleBrief(
  account: TargetAccount,
  resolution: BuyerResolution,
  reads: readonly ReadResult[],
  candidateHooks: readonly CandidateHook[],
  maxHooks: number = MAX_HOOKS,
): BuyerBrief {
  // Only successfully-read sources are eligible to ground a hook (the "did you read it?" gate).
  const readById = new Map<string, ReadResult>();
  for (const r of reads) if (r.ok) readById.set(r.sourceId, r);

  const cap = Math.max(0, Math.min(maxHooks, MAX_HOOKS));
  const hooks: AngleHook[] = [];
  for (const cand of candidateHooks) {
    const read = readById.get(cand.sourceId);
    if (!read) continue; // REJECT: no successfully-read source backs this hook
    hooks.push({
      angle: cand.angle,
      sourceId: read.sourceId,
      sourceUrl: read.url,
      retrievedAt: read.retrievedAt,
      evidence: read.excerpt,
    });
    if (hooks.length >= cap) break;
  }

  return {
    accountId: account.id,
    accountName: account.name,
    accountDomain: account.domain,
    buyerContactId: resolution.contact.id,
    buyerName: resolution.contact.name,
    buyerTitle: resolution.contact.title,
    buyerRole: resolution.role,
    rationale: resolution.rationale,
    caresAbout: caresAboutFrom(reads),
    hooks,
    fallbackTrail: resolution.fallbackTrail,
  };
}
