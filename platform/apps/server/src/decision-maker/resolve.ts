import type { AccountContact, BuyerRole, TargetAccount } from "./types.js";

/**
 * Pure buyer resolution (#223, ADR-0223). Given a target account (from #222), pick the best
 * decision-maker by a fixed priority with documented fallbacks, and attach a **falsifiable** "why this
 * person" rationale grounded in account data. No IO, no reads — purely a function of the account shape, so
 * the choice is deterministic and never influenced by anything the enrichment agent fetches (#200).
 */

/**
 * Resolution priority: a practitioner **champion** first (feels the pain daily), then the budget-holding
 * **economic buyer**, then the company's **agency**, then a **marketing** contact, and finally anyone
 * else. Mirrors the playbook's "the real buyer may be the VP, the agency, or someone in marketing".
 */
export const RESOLUTION_PRIORITY: readonly BuyerRole[] = [
  "champion",
  "economic_buyer",
  "agency",
  "marketing",
  "other",
];

export interface BuyerResolution {
  contact: AccountContact;
  role: BuyerRole;
  /** A falsifiable claim about why this is the right person (states the condition that would disprove it). */
  rationale: string;
  /** Higher-priority roles that were absent — the fallback trail walked to reach this contact. */
  fallbackTrail: BuyerRole[];
}

/** Raised when an account has no contact in any known role (an empty buyer pool). */
export class NoResolvableBuyerError extends Error {
  constructor(accountId: string) {
    super(`no resolvable buyer for account: ${accountId}`);
    this.name = "NoResolvableBuyerError";
  }
}

/**
 * The falsifiable rationale per role. Each states a checkable claim AND the condition under which the
 * resolution is wrong (and what it would fall back to) — so a human (or a later verifier) can refute it.
 * Built only from structured account fields; the enrichment text never feeds this.
 */
function buildRationale(account: TargetAccount, contact: AccountContact, role: BuyerRole): string {
  const who = `${contact.name} (${contact.title})`;
  const pain = account.painArea || "the target workflow";
  switch (role) {
    case "champion":
      return `${who} is the champion: their public role puts them on ${pain}, the workflow this product fixes. Falsifiable — if ${contact.name} does not own ${pain}, this resolution is wrong and should fall back to the economic buyer.`;
    case "economic_buyer":
      return `${who} is the economic buyer: the title carries budget authority over ${pain} at ${account.name}. Falsifiable — if ${contact.title} holds no budget for ${pain}, re-resolve to a practitioner champion or the agency.`;
    case "agency":
      return `${who} runs ${account.name}'s ${pain} via an agency, so the agency is the real buyer. Falsifiable — if ${account.name} has brought ${pain} in-house, re-resolve to the internal champion.`;
    case "marketing":
      return `${who} on the marketing team owns ${pain} day-to-day at ${account.name}. Falsifiable — if ${pain} is owned outside marketing, re-resolve to that owner or the economic buyer.`;
    case "other":
      return `${who} is the only reachable contact tied to ${pain} at ${account.name}. Falsifiable — if a champion, economic buyer, agency, or marketing owner exists, prefer them over this fallback.`;
  }
}

/**
 * Resolve the best buyer for an account. Walks {@link RESOLUTION_PRIORITY}; the first role present wins.
 * Every higher-priority role that was absent is recorded on `fallbackTrail` (transparency on the fallback
 * the playbook describes). Throws {@link NoResolvableBuyerError} when the pool is empty.
 */
export function resolveBuyer(account: TargetAccount): BuyerResolution {
  const fallbackTrail: BuyerRole[] = [];
  for (const role of RESOLUTION_PRIORITY) {
    const contact = account.contacts.find((c) => c.role === role);
    if (contact) {
      return { contact, role, rationale: buildRationale(account, contact, role), fallbackTrail };
    }
    fallbackTrail.push(role);
  }
  throw new NoResolvableBuyerError(account.id);
}
