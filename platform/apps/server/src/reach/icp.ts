import {
  isReachSignalKind,
  REACH_SIGNAL_KINDS,
  type Icp,
  type ReachSignalKind,
} from "./types.js";

/**
 * ICP derivation (#280 step 1) — learn the Ideal Customer Profile from the workspace domain + whatever the
 * founder console already knows (the venture wedge keywords, declared target market). Pure + deterministic
 * so it unit-tests without a DB and a given seed always yields the same ICP. The output is structured
 * filters only — nothing here becomes free instruction text downstream.
 */

/** What we feed ICP derivation: the workspace's own domain + optional hints from the founder console. */
export interface IcpSeed {
  /** The workspace's own domain (e.g. "ipop.ai") — the anchor the profile is learned from. */
  domain: string;
  /** Value-prop / product keywords (e.g. from the venture wedge). */
  productKeywords?: string[];
  /** Declared target industries, if the console knows them. */
  targetIndustries?: string[];
  /** Declared buyer roles/titles, if known. */
  targetRoles?: string[];
  /** Declared company-size buckets, if known. */
  targetCompanySizes?: string[];
  /** Buying signals the owner wants prioritised (reordered ahead of the defaults). */
  prioritySignals?: ReachSignalKind[];
}

/** Sensible default buyer roles for a B2B SaaS motion when the console hasn't declared any. */
const DEFAULT_ROLES = ["founder", "head of growth", "head of marketing", "vp marketing"];

/** Default size buckets — early-stage companies that buy without a procurement cycle. */
const DEFAULT_COMPANY_SIZES = ["1-10", "11-50", "51-200"];

/**
 * The default signal priority (highest intent first). Funding + a hiring surge are the strongest "they
 * have budget and a problem right now" signals; a job change is the weakest. Self-tune reorders this.
 */
const DEFAULT_SIGNAL_PRIORITY: readonly ReachSignalKind[] = [
  "funding_round",
  "hiring_surge",
  "pricing_page_visit",
  "tech_adoption",
  "content_engagement",
  "competitor_switch",
  "job_change",
];

const MAX_LIST = 12;

/** Normalise a free list: trim, lowercase, drop empties, dedupe, cap length. Keeps inputs as opaque chips. */
function normaliseList(values: readonly string[] | undefined, max = MAX_LIST): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const v = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Pull the bare registrable label out of a domain ("ipop.ai" → "ipop") as a fallback keyword. */
export function domainLabel(domain: string): string {
  const host = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
  const label = host.split(".")[0] ?? "";
  return label.replace(/[^a-z0-9]/g, "");
}

/**
 * Order signal kinds with the owner's priorities first, then the defaults, deduped. Unknown priority
 * entries are ignored (closed enum), so a poisoned hint can never inject a signal kind that isn't real.
 */
function orderSignals(priority: readonly ReachSignalKind[] | undefined): ReachSignalKind[] {
  const ordered: ReachSignalKind[] = [];
  const seen = new Set<ReachSignalKind>();
  for (const k of priority ?? []) {
    if (isReachSignalKind(k) && !seen.has(k)) {
      seen.add(k);
      ordered.push(k);
    }
  }
  for (const k of DEFAULT_SIGNAL_PRIORITY) {
    if (!seen.has(k)) {
      seen.add(k);
      ordered.push(k);
    }
  }
  // Belt-and-braces: guarantee every real kind is present exactly once.
  for (const k of REACH_SIGNAL_KINDS) if (!seen.has(k)) ordered.push(k);
  return ordered;
}

/**
 * Derive the ICP from a seed. Deterministic. Keywords default to the domain label when the console gave
 * none, so even a brand-new workspace gets a usable (if generic) profile to start sourcing against.
 */
export function deriveIcp(seed: IcpSeed): Icp {
  const domain = seed.domain.trim().toLowerCase();
  const keywords = normaliseList(seed.productKeywords);
  if (keywords.length === 0) {
    const label = domainLabel(domain);
    if (label) keywords.push(label);
  }
  const roles = normaliseList(seed.targetRoles);
  const companySizes = normaliseList(seed.targetCompanySizes);
  return {
    domain,
    industries: normaliseList(seed.targetIndustries),
    roles: roles.length > 0 ? roles : [...DEFAULT_ROLES],
    companySizes: companySizes.length > 0 ? companySizes : [...DEFAULT_COMPANY_SIZES],
    keywords,
    signalKinds: orderSignals(seed.prioritySignals),
  };
}
