/**
 * Cross-industry award-transfer — mechanism taxonomy + category distance (#1547, ADR-1547). Pure, no IO.
 *
 * THE IDEA (#1547, from the award-winning content engine epic #1539): a creative director does not copy the
 * winning ad in their own category — they raid a COMPLETELY UNRELATED industry, extract the underlying
 * MECHANISM (the reusable idea, e.g. "turned a product flaw into proof", "hijacked an existing ritual"), and
 * transfer that mechanism into the client's category. The execution is fresh; only the approach is borrowed.
 *
 * This file is the shared vocabulary that makes that systematic:
 *   - {@link CampaignMechanism} — the canonical, industry-agnostic mechanisms an award case is indexed BY
 *     (not by industry). This is the whole point: the archive is a mechanism library, so you retrieve
 *     "flaw-as-proof" and get cases from confectionery, aviation, and banking side by side.
 *   - {@link IndustryCategory} — a closed set of coarse client/industry categories used ONLY to enforce
 *     distance (reject a same-category reference — the creative-director rule "never steal from your own
 *     backyard"). It is deliberately coarse; a finer taxonomy is not needed to decide "is this distant?".
 *
 * No IO, no fetch, no DB — a pure vocabulary + the {@link isDistantCategory} predicate the transfer step
 * uses to reject near references. Unit-testable in isolation.
 */

/** The canonical, industry-agnostic mechanism an award case is indexed by. The archive's primary key. */
export type MechanismId =
  | "flaw-as-proof"
  | "hijacked-ritual"
  | "audience-as-medium"
  | "inverted-category-code"
  | "useful-not-loud"
  | "data-as-story"
  | "constraint-as-feature"
  | "borrowed-authority";

/** One mechanism: a short human label + a one-line description of the reusable move (never an execution). */
export interface CampaignMechanism {
  id: MechanismId;
  /** A short human label for the mechanism (title case). */
  label: string;
  /** The reusable move, stated abstractly so it transfers across categories — never a specific execution. */
  description: string;
}

/**
 * The mechanism library. Keep entries ABSTRACT: each describes a move, not an ad, so it maps onto any
 * category. Order is stable (it seeds the deterministic pick order in `transfer.ts`).
 */
export const MECHANISMS: Readonly<Record<MechanismId, CampaignMechanism>> = {
  "flaw-as-proof": {
    id: "flaw-as-proof",
    label: "Flaw as Proof",
    description:
      "Take the thing the product is criticised for and stage it as evidence of a deliberate virtue.",
  },
  "hijacked-ritual": {
    id: "hijacked-ritual",
    label: "Hijacked Ritual",
    description:
      "Attach the brand to an existing ritual, event, or symbol it does not own, and redirect its meaning.",
  },
  "audience-as-medium": {
    id: "audience-as-medium",
    label: "Audience as Medium",
    description:
      "Make the audience itself the channel — their own behaviour, bodies, or content carry the message.",
  },
  "inverted-category-code": {
    id: "inverted-category-code",
    label: "Inverted Category Code",
    description: "Do the exact opposite of every convention the category takes for granted.",
  },
  "useful-not-loud": {
    id: "useful-not-loud",
    label: "Useful, Not Loud",
    description: "Solve a real, tangible problem for the audience instead of running an ad about the brand.",
  },
  "data-as-story": {
    id: "data-as-story",
    label: "Data as Story",
    description: "Turn proprietary data the brand already holds into a personal, shareable narrative.",
  },
  "constraint-as-feature": {
    id: "constraint-as-feature",
    label: "Constraint as Feature",
    description: "Make a limitation, taboo, or rule the brand is stuck with the hero of the work.",
  },
  "borrowed-authority": {
    id: "borrowed-authority",
    label: "Borrowed Authority",
    description:
      "Co-opt the credibility of an unrelated institution, format, or object to make the message land.",
  },
};

/** Every mechanism id, in the stable library order (deterministic downstream selection). */
export const MECHANISM_IDS: readonly MechanismId[] = Object.keys(MECHANISMS) as MechanismId[];

/**
 * The coarse industry/category set used ONLY to enforce distance between a reference case and the client.
 * Deliberately broad — the point is "is this reference from a different world?", not a precise NAICS code.
 * `other` is the escape hatch for a client whose category isn't listed: it is treated as distant from every
 * named category (never rejects a real reference) while still rejecting another `other`-tagged reference.
 */
export type IndustryCategory =
  | "qsr-food"
  | "fmcg-food"
  | "fmcg-health"
  | "beverage-alcohol"
  | "beverage-soft-drinks"
  | "beauty-personal-care"
  | "apparel-sportswear"
  | "retail-outdoor"
  | "retail-furniture"
  | "retail-grocery"
  | "automotive"
  | "finance"
  | "insurance"
  | "tech-software"
  | "tech-music-streaming"
  | "telecom"
  | "news-media"
  | "entertainment"
  | "public-transport-safety"
  | "public-safety"
  | "travel-tourism-gov"
  | "nonprofit-health"
  | "gaming"
  | "other";

/**
 * Coarse adjacency: categories that are "the same backyard" for the purposes of the distance rule even
 * though they carry different labels (e.g. QSR and packaged food both sell food to the same aisle brain). A
 * reference in an adjacent category is rejected alongside an exact-category match, so the transfer really is
 * cross-industry. The map is symmetric-by-construction via {@link areAdjacent}. Absent ⇒ no adjacency.
 */
const ADJACENCY: Readonly<Partial<Record<IndustryCategory, readonly IndustryCategory[]>>> = {
  "qsr-food": ["fmcg-food", "retail-grocery"],
  "fmcg-food": ["qsr-food", "retail-grocery"],
  "retail-grocery": ["qsr-food", "fmcg-food"],
  "beverage-alcohol": ["beverage-soft-drinks"],
  "beverage-soft-drinks": ["beverage-alcohol"],
  "finance": ["insurance"],
  "insurance": ["finance"],
  "tech-software": ["tech-music-streaming"],
  "tech-music-streaming": ["tech-software"],
  "public-transport-safety": ["public-safety"],
  "public-safety": ["public-transport-safety"],
};

/** True when two categories sit in the same backyard (equal or listed adjacent, in either direction). */
function areAdjacent(a: IndustryCategory, b: IndustryCategory): boolean {
  return (ADJACENCY[a]?.includes(b) ?? false) || (ADJACENCY[b]?.includes(a) ?? false);
}

/**
 * The creative-director distance rule: a reference case is usable ONLY when it comes from a different world
 * than the client. Same category ⇒ rejected; an adjacent category ⇒ rejected; `other` vs a NAMED category ⇒
 * distant (we never reject a real, named reference just because the client is uncategorised). Two `other`s
 * are treated as same-backyard (rejected) — the conservative choice.
 */
export function isDistantCategory(client: IndustryCategory, reference: IndustryCategory): boolean {
  if (client === reference) return false;
  if (client === "other" && reference === "other") return false;
  if (client === "other" || reference === "other") return true;
  return !areAdjacent(client, reference);
}
