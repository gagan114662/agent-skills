/**
 * Cross-industry award-transfer — the reference archive (#1547, ADR-1547). Pure data, no IO.
 *
 * This is the "reference miner"'s index: a curated library of real, award-recognised campaigns drawn from
 * the public award case libraries the issue names (Cannes Lions, D&AD, One Show, Effie, Webby, ADC) and
 * their write-ups. The library's PRIMARY KEY is the {@link MechanismId} — the archive is organised by the
 * reusable MOVE ("flaw as proof", "hijacked ritual"), NOT by industry, so retrieving a mechanism returns
 * cases from wildly different categories side by side. That is what makes cross-industry transfer possible.
 *
 * The optional live crawler (`provider.ts`) can ENRICH this index from public write-ups behind the
 * SSRF-safe fetch guard, but the archive is code-authored and self-sufficient: the transfer step needs no
 * network to return real, named references. Every case here is a well-documented, publicly-discussed piece
 * of work; the `source` line points a human at where to read the case, and `award`/`year` are stated
 * conservatively (the value of a case is its MECHANISM, not the exact trophy).
 *
 * #200 note: this data is code-authored (trusted), but downstream render still bounds + frames it as DATA so
 * a future live-crawled addition can never smuggle instructions through the same path.
 */

import { type IndustryCategory, type MechanismId } from "./mechanism.js";

/** One reference case in the archive, indexed by its mechanism. */
export interface AwardCase {
  /** Stable id (kebab-case). */
  id: string;
  /** The named campaign — what a human would search for. */
  campaign: string;
  /** The brand / owner behind the work. */
  brand: string;
  /** The coarse category, used ONLY to enforce cross-industry distance from the client. */
  category: IndustryCategory;
  /** The mechanism this case is indexed by — the reusable move to transfer. */
  mechanism: MechanismId;
  /** Award recognition, stated conservatively (the mechanism matters more than the exact trophy). */
  award: string;
  /** Approximate year of the work. */
  year: number;
  /** Why the MECHANISM worked — the transferable insight, not a recap of the execution. */
  whyItWon: string;
  /** Where a human can read the case up (a public library / write-up pointer). */
  source: string;
  /**
   * The literal, case-specific execution elements — the surface a derivative draft would copy. Lens
   * (`derivative.ts`) flags a client draft that reuses these instead of transferring the abstract mechanism.
   */
  executionMotifs: readonly string[];
}

/**
 * The curated archive. Categories are spread widely so that for ANY client category there are at least
 * three DISTANT mechanisms available. Kept in a stable order (seeds deterministic selection downstream).
 */
export const AWARD_CASES: readonly AwardCase[] = [
  {
    id: "kfc-fck",
    campaign: "FCK",
    brand: "KFC UK",
    category: "qsr-food",
    mechanism: "flaw-as-proof",
    award: "D&AD / Cannes Lions recognised",
    year: 2018,
    whyItWon:
      "A supply failure (running out of chicken) was owned so bluntly and wittily that the apology itself " +
      "became proof the brand cared more about the product than its own dignity.",
    source: "D&AD Awards case library — KFC 'FCK'",
    executionMotifs: ["fck", "empty bucket", "chicken shortage", "rearranged letters"],
  },
  {
    id: "guinness-good-things",
    campaign: "Good Things Come To Those Who Wait",
    brand: "Guinness",
    category: "beverage-alcohol",
    mechanism: "flaw-as-proof",
    award: "Cannes Lions / industry recognised",
    year: 1996,
    whyItWon:
      "The slow pour — a genuine inconvenience — was reframed as the ritual that proves quality, turning a " +
      "reason-not-to-buy into the brand's central promise.",
    source: "Cannes Lions case library — Guinness 'Good Things Come To Those Who Wait'",
    executionMotifs: ["slow pour", "119.5 seconds", "surfer", "waves", "dancing man"],
  },
  {
    id: "state-street-fearless-girl",
    campaign: "Fearless Girl",
    brand: "State Street Global Advisors",
    category: "finance",
    mechanism: "hijacked-ritual",
    award: "Cannes Lions multiple Grand Prix",
    year: 2017,
    whyItWon:
      "Placing a small statue to face an existing landmark co-opted a symbol the brand did not own and " +
      "rewrote its meaning overnight — earned reach a paid campaign could never buy.",
    source: "Cannes Lions case library — State Street 'Fearless Girl'",
    executionMotifs: ["bronze statue", "charging bull", "wall street", "little girl", "gender diversity index"],
  },
  {
    id: "bk-whopper-detour",
    campaign: "Whopper Detour",
    brand: "Burger King",
    category: "qsr-food",
    mechanism: "hijacked-ritual",
    award: "Cannes Lions Grand Prix (Titanium/Direct)",
    year: 2019,
    whyItWon:
      "Turning a rival's own locations into the trigger for an offer hijacked the competitor's daily foot " +
      "traffic as free media — the audience's existing habit did the distribution.",
    source: "Cannes Lions case library — Burger King 'Whopper Detour'",
    executionMotifs: ["geofence", "mcdonald's", "1 cent whopper", "app unlock", "600 feet"],
  },
  {
    id: "coke-share-a-coke",
    campaign: "Share a Coke",
    brand: "Coca-Cola",
    category: "beverage-soft-drinks",
    mechanism: "audience-as-medium",
    award: "Cannes Lions recognised",
    year: 2011,
    whyItWon:
      "Printing consumers' own names on the pack made buyers the distributors: the message travelled because " +
      "people wanted to find, gift, and photograph themselves — not because media was bought.",
    source: "Cannes Lions case library — Coca-Cola 'Share a Coke'",
    executionMotifs: ["names on bottles", "personalised label", "find your name", "vending kiosk"],
  },
  {
    id: "als-ice-bucket",
    campaign: "Ice Bucket Challenge",
    brand: "ALS Association",
    category: "nonprofit-health",
    mechanism: "audience-as-medium",
    award: "Effie / industry recognised",
    year: 2014,
    whyItWon:
      "The audience literally became the medium — each participant filmed themselves and recruited the next " +
      "three, so the campaign's reach was manufactured entirely by the people it reached.",
    source: "Effie / Webby case write-ups — 'ALS Ice Bucket Challenge'",
    executionMotifs: ["bucket of ice water", "nominate three friends", "dump on head", "24 hours"],
  },
  {
    id: "rei-optoutside",
    campaign: "#OptOutside",
    brand: "REI",
    category: "retail-outdoor",
    mechanism: "inverted-category-code",
    award: "Cannes Lions Grand Prix (Titanium)",
    year: 2015,
    whyItWon:
      "Closing on the single biggest retail sales day did the exact opposite of every category rule — and " +
      "the sacrifice itself became the most persuasive statement of what the brand stood for.",
    source: "Cannes Lions case library — REI '#OptOutside'",
    executionMotifs: ["closed on black friday", "paid employees to go outside", "opt outside hashtag"],
  },
  {
    id: "metro-dumb-ways",
    campaign: "Dumb Ways to Die",
    brand: "Metro Trains Melbourne",
    category: "public-transport-safety",
    mechanism: "inverted-category-code",
    award: "Cannes Lions multiple Grand Prix",
    year: 2012,
    whyItWon:
      "A rail-safety message — a category built on fear — was made adorable and singable instead, so people " +
      "chose to share the warning rather than tune it out.",
    source: "Cannes Lions case library — Metro Trains 'Dumb Ways to Die'",
    executionMotifs: ["cute characters", "catchy song", "cartoon deaths", "train safety"],
  },
  {
    id: "ikea-thisables",
    campaign: "ThisAbles",
    brand: "IKEA",
    category: "retail-furniture",
    mechanism: "useful-not-loud",
    award: "Cannes Lions Grand Prix (Health)",
    year: 2019,
    whyItWon:
      "Instead of an ad, the brand shipped free 3D-printable add-ons that made existing products usable for " +
      "people with disabilities — solving a real problem earned more goodwill than any message could.",
    source: "Cannes Lions case library — IKEA 'ThisAbles'",
    executionMotifs: ["3d-printed add-ons", "accessibility", "downloadable files", "furniture hacks"],
  },
  {
    id: "dominos-paving-for-pizza",
    campaign: "Paving for Pizza",
    brand: "Domino's",
    category: "qsr-food",
    mechanism: "useful-not-loud",
    award: "Cannes Lions recognised",
    year: 2018,
    whyItWon:
      "The brand fixed real potholes in towns across the country — a concrete civic service framed as " +
      "protecting the product, which bought more affection than a product ad ever would.",
    source: "One Show / Cannes case write-ups — Domino's 'Paving for Pizza'",
    executionMotifs: ["fixing potholes", "branded manhole covers", "nominate your town", "road repairs"],
  },
  {
    id: "spotify-wrapped",
    campaign: "Wrapped",
    brand: "Spotify",
    category: "tech-music-streaming",
    mechanism: "data-as-story",
    award: "Webby / industry recognised",
    year: 2019,
    whyItWon:
      "Proprietary usage data was handed back to each user as a personal year-in-review they were proud to " +
      "post — the brand's own data became millions of pieces of user-authored advertising.",
    source: "Webby Awards case library — Spotify 'Wrapped'",
    executionMotifs: ["year-end recap", "top songs of the year", "shareable slides", "minutes listened"],
  },
  {
    id: "nyt-truth-is-worth-it",
    campaign: "The Truth Is Worth It",
    brand: "The New York Times",
    category: "news-media",
    mechanism: "data-as-story",
    award: "Cannes Lions Grand Prix (Film Craft)",
    year: 2019,
    whyItWon:
      "The raw evidence of the reporting process — the edits, the doubt, the persistence — was made the " +
      "narrative, turning proprietary process data into proof of the product's value.",
    source: "Cannes Lions case library — The New York Times 'The Truth Is Worth It'",
    executionMotifs: ["on-screen reporting notes", "typewriter text", "investigative process", "worth it tagline"],
  },
  {
    id: "female-company-tampon-book",
    campaign: "The Tampon Book",
    brand: "The Female Company",
    category: "fmcg-health",
    mechanism: "constraint-as-feature",
    award: "Cannes Lions Grand Prix (PR)",
    year: 2019,
    whyItWon:
      "A tax rule taxing tampons as luxury goods but books at a lower rate was turned into the product: " +
      "selling tampons inside a book made the unfair constraint the entire hero of the campaign.",
    source: "Cannes Lions case library — The Female Company 'The Tampon Book'",
    executionMotifs: ["tampons inside a book", "tax loophole", "19% vs 7%", "period tax protest"],
  },
  {
    id: "tac-meet-graham",
    campaign: "Meet Graham",
    brand: "Transport Accident Commission",
    category: "public-safety",
    mechanism: "constraint-as-feature",
    award: "Cannes Lions multiple Grand Prix",
    year: 2016,
    whyItWon:
      "The hard constraint — the human body is not built to survive crashes — was made literal as a sculpted " +
      "body that could, turning a limitation into an unforgettable, visitable argument.",
    source: "Cannes Lions case library — TAC 'Meet Graham'",
    executionMotifs: ["human sculpture", "crash-proof body", "interactive exhibit", "road trauma"],
  },
  {
    id: "palau-pledge",
    campaign: "Palau Pledge",
    brand: "Republic of Palau",
    category: "travel-tourism-gov",
    mechanism: "borrowed-authority",
    award: "Cannes Lions multiple Grand Prix",
    year: 2018,
    whyItWon:
      "The pledge borrowed the authority of an official immigration stamp — every arriving visitor had to " +
      "sign it in their passport — so a government document, not an ad, carried the behavioural ask.",
    source: "Cannes Lions case library — Palau 'Palau Pledge'",
    executionMotifs: ["passport stamp", "immigration pledge", "signed on arrival", "children's letter"],
  },
];

/** Retrieve every case indexed under a given mechanism (the archive's by-mechanism lookup). */
export function casesForMechanism(mechanism: MechanismId, cases: readonly AwardCase[] = AWARD_CASES): AwardCase[] {
  return cases.filter((c) => c.mechanism === mechanism);
}
