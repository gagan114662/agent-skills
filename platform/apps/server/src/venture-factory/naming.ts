/**
 * Naming precheck for the Venture Factory (#187, ADR-0187). **Pure + deterministic** (no network) — the
 * clean interface the #196 legal-compliance pack and downstream WHOIS/trademark integrations will plug
 * into, exposed now even though those pieces are not built on this branch.
 *
 * Two layers, mirroring the premortem reversibility classes (#200 FM#4):
 *   - `namingPrecheck` (here, deterministic): a cheap syntactic/blocklist gate that NEVER touches the
 *     world — it can reject a bad name for free and reshape a candidate name to a slug.
 *   - {@link NamingAvailabilityChecker} (a seam): the IRREVERSIBLE steps — does the domain resolve, is
 *     the trademark clear. The default stub answers `unknown` (it makes no network call), so the factory
 *     parks domain registration / trademark filing as human `venture.domain_purchase` / setup decisions
 *     rather than ever auto-registering. A real checker can be dropped in without touching callers.
 */

const MIN_LEN = 2;
const MAX_LEN = 40;

/**
 * Reserved/route-colliding words a venture name must not be (would clash with platform routes or read
 * as a system surface). Deterministic and conservative.
 */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "console",
  "dashboard",
  "internal",
  "login",
  "platform",
  "settings",
  "support",
  "system",
  "www",
]);

/** A tiny, conservative brand-safety blocklist (substring match on the normalized slug). */
const BLOCKLIST = ["scam", "fraud", "phish", "malware", "porn"];

/** The irreversible follow-up steps a passing name still requires before it is truly "ours". */
export type NamingStepKind = "domain_register" | "trademark_file";

export interface NamingStep {
  kind: NamingStepKind;
  /** Always irreversible / human — registration and filing cannot be undone cheaply (FM#4). */
  summary: string;
}

export interface NamingPrecheckResult {
  ok: boolean;
  /** The lowercased, hyphen-normalized slug derived from the input. */
  normalized: string;
  reasons: string[];
  /** Irreversible steps to park as human #13 decisions when `ok` (domain + trademark). */
  irreversibleSteps: NamingStep[];
}

/** Lowercase, collapse runs of non-alphanumerics to single hyphens, trim leading/trailing hyphens. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Deterministic precheck: validate the proposed name's shape and brand-safety. Pure — same input always
 * yields the same verdict. On `ok`, lists the irreversible registration/trademark steps the factory must
 * still gate behind a human (it does not assert availability — that is the {@link NamingAvailabilityChecker}).
 */
export function namingPrecheck(name: string): NamingPrecheckResult {
  const normalized = normalizeName(name);
  const reasons: string[] = [];

  if (normalized.length < MIN_LEN) {
    reasons.push(`name too short after normalization (min ${MIN_LEN})`);
  }
  if (normalized.length > MAX_LEN) {
    reasons.push(`name too long (max ${MAX_LEN})`);
  }
  if (RESERVED.has(normalized)) {
    reasons.push(`"${normalized}" is a reserved word`);
  }
  for (const bad of BLOCKLIST) {
    if (normalized.includes(bad)) {
      reasons.push(`name contains blocklisted term "${bad}"`);
    }
  }

  const ok = reasons.length === 0;
  return {
    ok,
    normalized,
    reasons,
    irreversibleSteps: ok
      ? [
          { kind: "domain_register", summary: `register ${normalized}.com (irreversible, human/MONEY)` },
          { kind: "trademark_file", summary: `clear/file trademark for "${normalized}" (irreversible, human)` },
        ]
      : [],
  };
}

/**
 * Availability of a name in the world (domain resolves? trademark clear?). The clean seam downstream
 * integrations implement. `available: null` means "not checked" — the default stub returns that for
 * everything so the factory NEVER auto-registers; it parks the step for a human instead.
 */
export interface NamingAvailability {
  /** `true` clear, `false` taken/conflicting, `null` not checked (no network call made). */
  domainAvailable: boolean | null;
  trademarkClear: boolean | null;
  reason: string;
}

export interface NamingAvailabilityChecker {
  check(normalizedName: string): Promise<NamingAvailability>;
}

/** The default checker: makes no network call, answers `null` (unknown) → always park for a human. */
export const stubNamingAvailabilityChecker: NamingAvailabilityChecker = {
  async check(normalizedName: string): Promise<NamingAvailability> {
    return {
      domainAvailable: null,
      trademarkClear: null,
      reason: `availability of "${normalizedName}" not checked (stub) — domain/trademark are human #13 decisions`,
    };
  },
};
