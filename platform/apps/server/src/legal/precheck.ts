/**
 * Name/trademark + domain-collision pre-check (#196, criterion 3). This exposes the clean `NamingPrecheck`
 * interface (in `types.ts`) the venture factory's naming step (#187, NOT yet built) calls *before anything
 * is purchased*, and ships a **deterministic stand-in** implementation — no real WHOIS / USPTO lookup, no
 * model spend, no network — mirroring how `venture/default.ts` ships deterministic gatherers. Swapping a
 * real registrar/trademark API in later is a one-line change in `legal/default.ts`; every caller and test
 * is unaffected because they depend on the interface, not this impl.
 *
 * The stub is intentionally transparent and repeatable: the same name always yields the same verdict, so
 * tests are stable and the owner can reason about why a name was flagged.
 */
import { createHash } from "node:crypto";
import type { DomainCollision, NamingPrecheck, NamingPrecheckResult, TrademarkRisk } from "./types.js";

/** A small set of well-known marks the stub treats as high trademark risk (illustrative, not exhaustive). */
const FAMOUS_MARKS = [
  "google", "apple", "amazon", "meta", "facebook", "microsoft", "netflix", "uber", "stripe", "openai",
  "tesla", "nike", "coca", "disney", "spotify", "youtube", "twitter", "instagram", "paypal", "visa",
];

/** Generic single words carry medium risk — hard to protect, likely already registered somewhere. */
function isGenericWord(name: string): boolean {
  return /^[a-z]+$/.test(name) && name.length <= 6;
}

function digitHex(seed: string): number {
  return parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
}

/** Assess trademark risk for a name (pure, deterministic). Exported for direct unit testing. */
export function assessTrademark(name: string): { risk: TrademarkRisk; notes: string[] } {
  const norm = name.trim().toLowerCase();
  const notes: string[] = [];
  if (!norm) {
    return { risk: "high", notes: ["empty name"] };
  }
  for (const mark of FAMOUS_MARKS) {
    if (norm.includes(mark)) {
      notes.push(`name contains the well-known mark “${mark}” — high collision/dilution risk`);
      return { risk: "high", notes };
    }
  }
  if (isGenericWord(norm)) {
    notes.push("short generic dictionary word — likely already registered and hard to protect");
    return { risk: "medium", notes };
  }
  notes.push("no obvious conflict found in the deterministic pre-check (NOT a cleared trademark search)");
  return { risk: "low", notes };
}

/** Deterministically decide whether a candidate domain is "available" (stub; same input ⇒ same answer). */
export function checkDomain(domain: string): DomainCollision {
  const norm = domain.trim().toLowerCase();
  // A name embedding a famous mark is never "available" (it would collide); otherwise deterministic by hash.
  const collidesFamous = FAMOUS_MARKS.some((m) => norm.includes(m));
  const available = !collidesFamous && digitHex(norm) % 3 !== 0;
  return { domain: norm, available };
}

/** The deterministic production stand-in. Network-free, repeatable, model-free. */
export const deterministicNamingPrecheck: NamingPrecheck = {
  check(input): Promise<NamingPrecheckResult> {
    const { risk, notes } = assessTrademark(input.name);
    const domainCollisions = input.domains.map(checkDomain);
    const clearToProceed = risk !== "high" && domainCollisions.some((d) => d.available);
    return Promise.resolve({
      name: input.name.trim(),
      trademarkRisk: risk,
      trademarkNotes: notes,
      domainCollisions,
      clearToProceed,
    });
  },
};
