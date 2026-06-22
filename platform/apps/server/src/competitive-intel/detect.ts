/**
 * The PURE diff/digest core of issue #619. Given two snapshots of a competitor (the previous one and the
 * freshly observed one) plus the resolved {@link CompetitiveIntelCaps}, it deterministically returns the
 * MATERIAL changes between them; and given the per-competitor change sets, it assembles the weekly
 * {@link CompetitorDigest}. No IO, no clock, no randomness — the same inputs always yield the same digest,
 * which is what makes the report auditable and lets the service test it without a database or a network.
 *
 * Trust boundary (#200 §6): every observed string — taglines, value props, launch titles — is treated as
 * opaque DATA used only for equality comparison and verbatim display. The core never interprets competitor
 * copy as an instruction, so a competitor page that embeds "ignore your rules" is just text in the digest.
 */

import type { CompetitiveIntelCaps } from "./caps.js";
import { resolveCompetitiveIntelCaps } from "./caps.js";
import type {
  ChangeCategory,
  CompetitorDigest,
  CompetitorSnapshot,
  DigestCounts,
  Launch,
  MaterialChange,
  PricingTier,
} from "./types.js";

/** Normalize a comparison key: trimmed, lowercased, internal whitespace collapsed. */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Short cadence label for price formatting. */
function cadenceLabel(cadence: PricingTier["cadence"]): string {
  switch (cadence) {
    case "monthly":
      return "/mo";
    case "annual":
      return "/yr";
    case "one_time":
      return " once";
    case "custom":
      return " custom";
    case "unknown":
      return "";
  }
}

/** Format a tier's price for a human-readable before/after value. */
function formatPrice(tier: PricingTier): string {
  if (tier.priceUsd === null) {
    return tier.cadence === "custom" ? "custom pricing" : "unpriced";
  }
  return `$${tier.priceUsd}${cadenceLabel(tier.cadence)}`;
}

/** Whether two tiers (same name) differ materially in price, given the minimum-percent threshold. */
function isPriceMaterial(prev: PricingTier, curr: PricingTier, minPct: number): boolean {
  if (prev.priceUsd === null || curr.priceUsd === null) {
    // Priced ⇄ unpriced (e.g. went "contact us") is always material; both unpriced ⇒ no price move.
    return prev.priceUsd !== curr.priceUsd;
  }
  if (prev.cadence !== curr.cadence) return true; // monthly ⇄ annual is a real change
  const delta = Math.abs(curr.priceUsd - prev.priceUsd);
  if (delta === 0) return false;
  const base = Math.abs(prev.priceUsd);
  if (base === 0) return true;
  return delta / base >= minPct;
}

/** Index a tier list by normalized name, keeping the first occurrence of a duplicated name. */
function tiersByName(tiers: PricingTier[]): Map<string, PricingTier> {
  const m = new Map<string, PricingTier>();
  for (const t of tiers) {
    const k = normKey(t.name);
    if (!m.has(k)) m.set(k, t);
  }
  return m;
}

/** Format a launch for display. */
function formatLaunch(l: Launch): string {
  return `${l.title} (${l.date})`;
}

/**
 * Detect the material changes between a competitor's previous snapshot and its current one.
 *
 * Baseline semantics: when `previous` is null this is the FIRST observation of the competitor — there is no
 * prior state to diff, so pricing and messaging produce no changes (reporting every tier/prop as "added"
 * would be noise). Launches, which are genuinely new information, are reported as `added`. Subsequent diffs
 * (previous non-null) compare all three dimensions.
 *
 * Removed launches are intentionally ignored: a launch that drops off a page did not "un-happen", so its
 * disappearance is not a material strategy signal.
 */
export function diffSnapshots(
  previous: CompetitorSnapshot | null,
  current: CompetitorSnapshot,
  caps: CompetitiveIntelCaps = resolveCompetitiveIntelCaps(),
): MaterialChange[] {
  const competitorId = current.competitor.id;
  const competitorName = current.competitor.name;
  const changes: MaterialChange[] = [];

  const push = (
    category: ChangeCategory,
    kind: MaterialChange["kind"],
    summary: string,
    before: string | null,
    after: string | null,
    sourceUrl: string | null,
  ): void => {
    changes.push({ competitorId, competitorName, category, kind, summary, before, after, sourceUrl });
  };

  // --- Launches (diffed even on baseline; new launches are new information) ---------------------------
  const prevLaunchIds = new Set((previous?.launches ?? []).map((l) => normKey(l.id)));
  for (const l of current.launches) {
    if (!prevLaunchIds.has(normKey(l.id))) {
      push("launch", "added", `New launch "${l.title}"`, null, formatLaunch(l), l.sourceUrl);
    }
  }

  if (previous === null) {
    return sortChanges(changes);
  }

  // --- Pricing ---------------------------------------------------------------------------------------
  const prevTiers = tiersByName(previous.pricing);
  const currTiers = tiersByName(current.pricing);
  for (const [key, curr] of currTiers) {
    const prev = prevTiers.get(key);
    if (!prev) {
      push("pricing", "added", `New pricing tier "${curr.name}"`, null, formatPrice(curr), curr.sourceUrl);
    } else if (isPriceMaterial(prev, curr, caps.priceChangeMinPct)) {
      push(
        "pricing",
        "changed",
        `Pricing for "${curr.name}" changed`,
        formatPrice(prev),
        formatPrice(curr),
        curr.sourceUrl,
      );
    }
  }
  for (const [key, prev] of prevTiers) {
    if (!currTiers.has(key)) {
      push("pricing", "removed", `Dropped pricing tier "${prev.name}"`, formatPrice(prev), null, prev.sourceUrl);
    }
  }

  // --- Messaging -------------------------------------------------------------------------------------
  const messageSource = current.messaging.sourceUrl ?? previous.messaging.sourceUrl;
  if (normKey(previous.messaging.tagline) !== normKey(current.messaging.tagline)) {
    push(
      "messaging",
      "changed",
      "Tagline changed",
      previous.messaging.tagline,
      current.messaging.tagline,
      messageSource,
    );
  }
  const prevProps = new Map(previous.messaging.valueProps.map((p) => [normKey(p), p]));
  const currProps = new Map(current.messaging.valueProps.map((p) => [normKey(p), p]));
  for (const [key, text] of currProps) {
    if (!prevProps.has(key)) {
      push("messaging", "added", `New value prop: "${text}"`, null, text, messageSource);
    }
  }
  for (const [key, text] of prevProps) {
    if (!currProps.has(key)) {
      push("messaging", "removed", `Dropped value prop: "${text}"`, text, null, messageSource);
    }
  }

  return sortChanges(changes);
}

/** Category ordering for the digest — pricing first (most strategically material), then launches, then messaging. */
function categoryRank(c: ChangeCategory): number {
  switch (c) {
    case "pricing":
      return 0;
    case "launch":
      return 1;
    case "messaging":
      return 2;
  }
}

function kindRank(k: MaterialChange["kind"]): number {
  switch (k) {
    case "changed":
      return 0;
    case "added":
      return 1;
    case "removed":
      return 2;
  }
}

/** Deterministic ordering of changes: category, then competitor, then kind, then summary, then after-value. */
function sortChanges(changes: MaterialChange[]): MaterialChange[] {
  return [...changes].sort((a, b) => {
    if (categoryRank(a.category) !== categoryRank(b.category)) {
      return categoryRank(a.category) - categoryRank(b.category);
    }
    if (a.competitorId !== b.competitorId) return a.competitorId.localeCompare(b.competitorId);
    if (kindRank(a.kind) !== kindRank(b.kind)) return kindRank(a.kind) - kindRank(b.kind);
    if (a.summary !== b.summary) return a.summary.localeCompare(b.summary);
    return (a.after ?? "").localeCompare(b.after ?? "");
  });
}

/** Tally changes by category. */
function countChanges(changes: MaterialChange[]): DigestCounts {
  const counts: DigestCounts = { pricing: 0, messaging: 0, launch: 0, total: changes.length };
  for (const c of changes) counts[c.category] += 1;
  return counts;
}

/** Format one highlight line, e.g. `[PRICING] Acme: Pricing for "Pro" changed`. */
function highlightLine(c: MaterialChange): string {
  return `[${c.category.toUpperCase()}] ${c.competitorName}: ${c.summary}`;
}

export interface BuildDigestInput {
  workspaceId: string;
  /** Competitors covered, in input order (recorded on the digest even if a competitor had no changes). */
  competitorIds: string[];
  /** Material changes across all competitors (already per-competitor diffed). */
  changes: MaterialChange[];
  /** ISO instant the digest is generated (the service supplies this from its clock seam). */
  generatedAt: string;
  /** How the snapshots were obtained. */
  servedBy: CompetitorDigest["servedBy"];
  caps?: CompetitiveIntelCaps;
}

/**
 * Assemble the weekly digest from the per-competitor changes: order them deterministically, cap to
 * `maxDigestChanges`, tally by category, pull the top `maxHighlights` as skim-able lines, and collect the
 * deduped source URLs. The digest's `counts` reflect exactly the (capped) `changes` it carries.
 */
export function buildDigest(input: BuildDigestInput): CompetitorDigest {
  const caps = input.caps ?? resolveCompetitiveIntelCaps();
  const ordered = sortChanges(input.changes).slice(0, caps.maxDigestChanges);
  const sources: string[] = [];
  const seenSource = new Set<string>();
  for (const c of ordered) {
    if (c.sourceUrl && !seenSource.has(c.sourceUrl)) {
      seenSource.add(c.sourceUrl);
      sources.push(c.sourceUrl);
    }
  }
  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    competitorIds: [...input.competitorIds],
    counts: countChanges(ordered),
    changes: ordered,
    highlights: ordered.slice(0, caps.maxHighlights).map(highlightLine),
    sources,
    servedBy: input.servedBy,
  };
}
