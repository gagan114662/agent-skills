import { EDGE_KINDS, type EdgeClaim, type EdgeKind, type EdgeVerdict } from "./types.js";

/**
 * The EDGE GATE (#187, premortem #200 FM#1) — the single most important rule in the factory. **Pure**,
 * dependency-free, so every path is a fast unit test and it is the one source of truth for "may this
 * candidate become a company?".
 *
 * Premortem failure mode #1: *zero-cost execution is not a moat; every fleet reads the same trends.* So
 * **no venture launches without a falsifiable distribution / data / relationship edge.** A claim only
 * qualifies if it is:
 *   1. one of the three real edge classes ({@link EDGE_KINDS}) — not "we'll execute better";
 *   2. **falsifiable** — it carries a concrete disproof test (`falsifiableTest`). An edge you cannot
 *      disprove is a hope, not an edge;
 *   3. **evidenced** — at least one piece of provenance that is an EXTERNAL receipt or an owner-attested
 *      secret (premortem FM#2: self-asserted "we think competitors can't" does not count).
 *
 * The factory refuses to bootstrap a candidate whose `decideEdgeGate(...).status !== "qualified"`.
 */

/** Why a single claim failed (or `null` when it qualifies). */
function disqualify(claim: EdgeClaim): string | null {
  if (!EDGE_KINDS.includes(claim.kind)) {
    return `not a real edge class (got "${claim.kind}")`;
  }
  if (claim.statement.trim() === "") {
    return "empty edge statement";
  }
  if (claim.falsifiableTest.trim() === "") {
    return "no falsifiable disproof test — an edge you cannot disprove is not an edge";
  }
  if (claim.evidence.length === 0) {
    return "no cited evidence";
  }
  const strong = claim.evidence.some((e) => e.external || e.ownerAttested);
  if (!strong) {
    return "evidence is self-asserted only (no external receipt or owner-attested secret)";
  }
  return null;
}

export interface EdgeGateInput {
  claims: EdgeClaim[];
}

/**
 * Decide whether a candidate clears the edge gate. `qualified` iff at least one claim is a falsifiable,
 * evidenced edge in one of the three classes; otherwise `rejected` with a reason per failing claim.
 * Total and pure.
 */
export function decideEdgeGate(input: EdgeGateInput): EdgeVerdict {
  const qualifying: EdgeClaim[] = [];
  const reasons: string[] = [];

  for (const claim of input.claims) {
    const why = disqualify(claim);
    if (why === null) {
      qualifying.push(claim);
    } else {
      reasons.push(`${claim.kind}: ${why}`);
    }
  }

  if (qualifying.length === 0) {
    return {
      status: "rejected",
      qualifyingClaims: [],
      edgeClasses: [],
      reasons: reasons.length > 0 ? reasons : ["no edge claims provided"],
    };
  }

  const edgeClasses: EdgeKind[] = [...new Set(qualifying.map((c) => c.kind))];
  return {
    status: "qualified",
    qualifyingClaims: qualifying,
    edgeClasses,
    reasons: [`${qualifying.length} qualifying edge(s): ${edgeClasses.join(", ")}`],
  };
}

/**
 * The factory-level scaling discipline (premortem #200 FM#1, second sentence: *make ONE venture
 * profitable end-to-end before scaling the factory*). **Pure.** A new bootstrap is barred while a
 * venture is already active and none of them is **externally** profitable (FM#2 — a self-reported P&L
 * does not count). Also enforces a hard concurrency cap.
 */
export interface FactoryAdmissionInput {
  /** Bootstrapped ventures still active (not archived/killed). */
  activeVentures: number;
  /** Of those, how many have an EXTERNAL profitability receipt (revenue > cost, externally verified). */
  profitableVentures: number;
  /** Hard cap on concurrently-active ventures. */
  maxConcurrentVentures: number;
  /** When true, bar a new bootstrap until at least one venture is externally profitable. */
  requireProfitableBeforeScale: boolean;
}

export interface FactoryAdmissionDecision {
  allowed: boolean;
  reason: string;
}

export function decideFactoryAdmission(input: FactoryAdmissionInput): FactoryAdmissionDecision {
  if (input.requireProfitableBeforeScale && input.activeVentures >= 1 && input.profitableVentures === 0) {
    return {
      allowed: false,
      reason: `make one venture profitable before scaling: ${input.activeVentures} active, 0 externally-profitable`,
    };
  }
  if (input.activeVentures >= input.maxConcurrentVentures) {
    return {
      allowed: false,
      reason: `at venture concurrency cap (${input.activeVentures}/${input.maxConcurrentVentures})`,
    };
  }
  return {
    allowed: true,
    reason: `admitted: ${input.activeVentures}/${input.maxConcurrentVentures} active, ${input.profitableVentures} externally profitable`,
  };
}
