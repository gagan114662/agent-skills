/**
 * Shared types for the competitive-intelligence monitoring module (issue #619).
 *
 * The problem: positioning drifts when no one is watching what competitors do. The fix is an agent that
 * tracks each competitor's PRICING, MESSAGING, and LAUNCHES over time and, on a weekly cadence, emits a
 * digest that highlights the MATERIAL changes since the last snapshot — every change carrying the source it
 * was observed at, so a strategist can act on it.
 *
 * Everything here is plain data. The pure diff/digest core in `detect.ts` reads only these structural fields
 * and treats every observed string (taglines, value props, launch titles) as opaque DATA for comparison — it
 * never interprets competitor copy as instructions, so a poisoned competitor page can never steer the digest
 * (#200 §6 trust boundary).
 */

/** A competitor being tracked. Workspace-scoped at the store/service layer (#3 IDOR). */
export interface CompetitorRef {
  /** Stable id for this competitor within a workspace (e.g. a slug like "acme"). */
  id: string;
  /** Human-readable competitor name shown in the digest. */
  name: string;
  /** Optional homepage, used by the fake provider to derive plausible source URLs. */
  homepageUrl?: string | null;
}

/** Billing cadence for a pricing tier. `unknown` when a provider could not classify it. */
export type PriceCadence = "monthly" | "annual" | "one_time" | "custom" | "unknown";

/** One observed pricing tier for a competitor. */
export interface PricingTier {
  /** Tier name as published ("Starter", "Pro", "Enterprise"). Matched case/space-insensitively across snapshots. */
  name: string;
  /** Headline price in USD, or null for "contact us" / unpriced tiers. */
  priceUsd: number | null;
  /** Billing cadence the price is quoted at. */
  cadence: PriceCadence;
  /** Where this tier was observed — the source that backs any change reported about it. */
  sourceUrl: string | null;
}

/** The competitor's current positioning copy. */
export interface MessagingSnapshot {
  /** Primary tagline / hero headline. */
  tagline: string;
  /** Bullet value-props. Matched as a set (case/space-insensitive) across snapshots to detect add/remove. */
  valueProps: string[];
  /** Where the messaging was observed. */
  sourceUrl: string | null;
}

/** One product launch / announcement observed for a competitor. */
export interface Launch {
  /** Stable id for the launch (used to dedupe across snapshots). */
  id: string;
  /** Launch / announcement title. */
  title: string;
  /** ISO date the launch was announced (provider-supplied; the core never reads the wall clock). */
  date: string;
  /** Where the launch was observed. */
  sourceUrl: string | null;
}

/** A full point-in-time observation of one competitor — what a provider returns for `fetchSnapshot`. */
export interface CompetitorSnapshot {
  competitor: CompetitorRef;
  pricing: PricingTier[];
  messaging: MessagingSnapshot;
  launches: Launch[];
}

/** Which dimension a material change belongs to. */
export type ChangeCategory = "pricing" | "messaging" | "launch";

/** The shape of a change. */
export type ChangeKind = "added" | "removed" | "changed";

/**
 * One material change detected between two snapshots of a competitor. Carries the human summary plus the
 * before/after values and — crucially for the acceptance criterion — the source URL it was observed at.
 */
export interface MaterialChange {
  competitorId: string;
  competitorName: string;
  category: ChangeCategory;
  kind: ChangeKind;
  /** Short, human-readable description of what changed. */
  summary: string;
  /** Prior value (null for `added`). A formatted string so the digest is self-contained. */
  before: string | null;
  /** New value (null for `removed`). */
  after: string | null;
  /** The source backing this change ("with sources" — #619 acceptance). */
  sourceUrl: string | null;
}

/** Counts of changes by category, surfaced at the top of a digest. */
export interface DigestCounts {
  pricing: number;
  messaging: number;
  launch: number;
  total: number;
}

/**
 * A weekly competitor digest: the material changes across all tracked competitors, summarized with sources.
 * `servedBy` records the data path so a reader can tell live data from the offline fake.
 */
export interface CompetitorDigest {
  workspaceId: string;
  /** ISO instant the digest was generated (service-stamped via its clock seam). */
  generatedAt: string;
  /** The competitors covered, in input order. */
  competitorIds: string[];
  counts: DigestCounts;
  /** Every material change, deterministically ordered, each with its source. */
  changes: MaterialChange[];
  /** Short headline lines a reader skims first (one per most-material change, capped). */
  highlights: string[];
  /** Deduped list of every source URL cited in the digest. */
  sources: string[];
  /**
   * How the underlying snapshots were obtained:
   *   - "fake-disabled": the module is OFF — deterministic offline fake data, no external call.
   *   - "fake-fallback": the module is ON but the live source threw — fell back to fake data.
   *   - "live": the module is ON and the injected live source served every competitor.
   */
  servedBy: "fake-disabled" | "fake-fallback" | "live";
}
