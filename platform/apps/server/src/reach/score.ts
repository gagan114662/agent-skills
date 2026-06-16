import type { BuyingSignal, Icp, RawProspect, ScoredProspect } from "./types.js";

/**
 * Prospect scoring + dedupe (#280 step 3). Pure. Two jobs:
 *   1. Score each prospect 0–100 on ICP FIT (role / industry / size / keyword match) blended with the
 *      strength + recency of its freshest qualifying buying signal — so a perfect-fit account with a
 *      week-old funding round outranks a so-so fit with a stale signal.
 *   2. Dedupe against everyone already contacted, so we never re-touch last week's list (the explicit
 *      #280 requirement). Dedupe is by a stable {@link contactKey} derived ONLY from structured contact
 *      fields, never from signal text.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a signal stays "fresh". Full weight inside the window, linear decay to zero over 4× the window. */
const SIGNAL_FRESH_DAYS = 7;
const SIGNAL_STALE_DAYS = 28;

/**
 * The stable dedupe identity for a prospect. Prefers the normalised email (the real send target), then the
 * LinkedIn URL, then a normalised name|company. Derived ONLY from structured fields — a poisoned signal
 * can never change who we think a prospect is.
 */
export function contactKey(prospect: RawProspect): string {
  const email = prospect.email?.trim().toLowerCase();
  if (email) return `email:${email}`;
  const linkedin = prospect.linkedinUrl?.trim().toLowerCase();
  if (linkedin) return `linkedin:${linkedin}`;
  const name = prospect.fullName.trim().toLowerCase().replace(/\s+/g, " ");
  const company = prospect.company.trim().toLowerCase().replace(/\s+/g, " ");
  return `id:${name}|${company}`;
}

/** Lowercased haystack of the prospect's structured text fields, for keyword/role matching. */
function haystack(prospect: RawProspect): string {
  return [prospect.title, prospect.company, prospect.industry ?? ""].join(" ").toLowerCase();
}

/** Recency weight in [0,1]: full inside SIGNAL_FRESH_DAYS, linear decay to 0 at SIGNAL_STALE_DAYS. */
function recencyWeight(observedAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - observedAtMs) / DAY_MS);
  if (ageDays <= SIGNAL_FRESH_DAYS) return 1;
  if (ageDays >= SIGNAL_STALE_DAYS) return 0;
  return 1 - (ageDays - SIGNAL_FRESH_DAYS) / (SIGNAL_STALE_DAYS - SIGNAL_FRESH_DAYS);
}

/**
 * Pick the single signal the opener should be built around: the highest-priority kind per the ICP order,
 * breaking ties by recency. Only signals whose kind appears in the ICP count (an off-ICP signal is noise).
 * Returns null when the prospect has no qualifying signal.
 */
export function pickFreshSignal(prospect: RawProspect, icp: Icp, nowMs: number): BuyingSignal | null {
  let best: BuyingSignal | null = null;
  let bestScore = -1;
  for (const signal of prospect.signals) {
    const priorityIdx = icp.signalKinds.indexOf(signal.kind);
    if (priorityIdx < 0) continue; // off-ICP signal — ignore
    // Higher-priority kinds (lower index) and fresher signals win.
    const priorityWeight = (icp.signalKinds.length - priorityIdx) / icp.signalKinds.length;
    const score = priorityWeight * 0.6 + recencyWeight(signal.observedAtMs, nowMs) * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = signal;
    }
  }
  return best;
}

/**
 * Score one prospect 0–100. Fit is the structured-match base (up to 60); the freshest qualifying signal
 * adds up to 40 (kind priority × recency). A prospect with zero ICP signal still scores on fit alone.
 */
export function scoreProspect(prospect: RawProspect, icp: Icp, nowMs: number): ScoredProspect {
  const reasons: string[] = [];
  const hay = haystack(prospect);
  let fit = 0;

  const role = icp.roles.find((r) => hay.includes(r));
  if (role) {
    fit += 24;
    reasons.push(`role match: ${role}`);
  }
  if (prospect.industry && icp.industries.some((i) => prospect.industry!.toLowerCase().includes(i))) {
    fit += 12;
    reasons.push(`industry match: ${prospect.industry}`);
  }
  if (prospect.companySize && icp.companySizes.includes(prospect.companySize)) {
    fit += 12;
    reasons.push(`company-size match: ${prospect.companySize}`);
  }
  const keyword = icp.keywords.find((k) => hay.includes(k));
  if (keyword) {
    fit += 12;
    reasons.push(`keyword match: ${keyword}`);
  }
  fit = Math.min(60, fit);

  const freshSignal = pickFreshSignal(prospect, icp, nowMs);
  let signalScore = 0;
  if (freshSignal) {
    const priorityIdx = icp.signalKinds.indexOf(freshSignal.kind);
    const priorityWeight = (icp.signalKinds.length - priorityIdx) / icp.signalKinds.length;
    const recency = recencyWeight(freshSignal.observedAtMs, nowMs);
    signalScore = Math.round(40 * (priorityWeight * 0.6 + recency * 0.4));
    reasons.push(`live signal: ${freshSignal.kind} (recency ${recency.toFixed(2)})`);
  } else {
    reasons.push("no live ICP signal");
  }

  return {
    prospect,
    contactKey: contactKey(prospect),
    score: Math.min(100, Math.max(0, fit + signalScore)),
    scoreReasons: reasons,
    freshSignal,
  };
}

/** Drop prospects whose {@link contactKey} is already in the contacted set (never re-touch last week's list). */
export function dedupeAgainstContacted(
  scored: ScoredProspect[],
  alreadyContacted: ReadonlySet<string>,
): ScoredProspect[] {
  const seenThisBatch = new Set<string>();
  const out: ScoredProspect[] = [];
  for (const s of scored) {
    if (alreadyContacted.has(s.contactKey) || seenThisBatch.has(s.contactKey)) continue;
    seenThisBatch.add(s.contactKey);
    out.push(s);
  }
  return out;
}

/**
 * Score → dedupe → rank a raw batch, returning the top `limit` net-new prospects, highest score first
 * (ties broken by contactKey for determinism). The end-to-end step 3 of the loop.
 */
export function rankBatch(
  prospects: RawProspect[],
  icp: Icp,
  alreadyContacted: ReadonlySet<string>,
  nowMs: number,
  limit: number,
): ScoredProspect[] {
  const scored = prospects.map((p) => scoreProspect(p, icp, nowMs));
  const fresh = dedupeAgainstContacted(scored, alreadyContacted);
  fresh.sort((a, b) => b.score - a.score || a.contactKey.localeCompare(b.contactKey));
  return limit > 0 ? fresh.slice(0, limit) : fresh;
}
