/**
 * Regulated-industry detection + naming disposition (#196, criterion 5). A purely deterministic classifier
 * over a venture's industry label + the data it collects: if it looks like a regulated space (health,
 * finance, children's data, etc.), the venture is flagged **high-risk** and must **hard-stop to the owner**
 * — autonomous launch is never allowed to clear that gate. No IO, no model: a transparent keyword map so
 * the rule is auditable and testable, and a false positive is a safe failure (owner just reviews).
 */
import type { NamingPrecheckResult, RegulatedAssessment } from "./types.js";

/** Regulated category → the trigger tokens that imply it. Conservative: err toward flagging. */
const REGULATED_KEYWORDS: Record<string, string[]> = {
  health: ["health", "medical", "clinical", "patient", "hipaa", "therapy", "mental", "pharma", "telehealth", "diagnos"],
  finance: ["bank", "lending", "loan", "credit", "securities", "broker", "invest", "trading", "insurance", "mortgage", "payday", "money transfer", "remittance"],
  children: ["child", "children", "kids", "minor", "coppa", "k-12", "school", "student"],
  crypto: ["crypto", "blockchain", "token", "defi", "web3", "nft"],
  cannabis: ["cannabis", "marijuana", "cbd", "thc", "dispensary"],
  gambling: ["gambling", "casino", "betting", "wager", "lottery", "sportsbook"],
  legal: ["law firm", "legal services", "attorney", "immigration"],
  biometric: ["biometric", "facial recognition", "fingerprint", "genetic", "dna"],
};

/** Data tokens that, on their own, imply a regulated obligation regardless of the industry label. */
const SENSITIVE_DATA_CATEGORY: Record<string, string> = {
  health: "health",
  medical: "health",
  biometric: "biometric",
  genetic: "biometric",
  ssn: "finance",
  children: "children",
  minors: "children",
};

function matchKeywords(haystack: string): { category: string; reasons: string[] } | null {
  const reasons: string[] = [];
  let category: string | null = null;
  for (const [cat, tokens] of Object.entries(REGULATED_KEYWORDS)) {
    for (const tok of tokens) {
      if (haystack.includes(tok)) {
        category ??= cat;
        reasons.push(`matched regulated term “${tok}” (${cat})`);
        break;
      }
    }
  }
  return category ? { category, reasons } : null;
}

/**
 * Assess whether a venture operates in a regulated industry. `industry` is the free-form label;
 * `dataCollected` the normalized data tokens. A match → `regulated:true` with `disposition:"hard_stop"`.
 */
export function assessRegulated(input: { industry: string | null; dataCollected: string[] }): RegulatedAssessment {
  const reasons: string[] = [];
  let category: string | null = null;

  const label = (input.industry ?? "").toLowerCase();
  if (label) {
    const m = matchKeywords(label);
    if (m) {
      category ??= m.category;
      reasons.push(...m.reasons);
    }
  }

  for (const raw of input.dataCollected) {
    const t = raw.trim().toLowerCase();
    const cat = SENSITIVE_DATA_CATEGORY[t];
    if (cat) {
      category ??= cat;
      reasons.push(`collects sensitive data “${t}” (${cat})`);
    }
  }

  const regulated = category !== null;
  return {
    regulated,
    category,
    reasons,
    disposition: regulated ? "hard_stop" : "proceed",
  };
}

/**
 * Combine a naming pre-check with a regulated assessment into the disposition for the naming decision.
 * - regulated high-risk ⇒ `hard_stop` (owner + counsel; never auto-approvable);
 * - else trademark/domain concerns (high/medium risk, no clear domain) ⇒ `owner_review`;
 * - else `proceed`.
 * Either way the caller attaches this to a pending #13 approval — `hard_stop` simply means the summary
 * tells the owner it must not launch without counsel.
 */
export function decideNamingDisposition(
  precheck: NamingPrecheckResult,
  regulated: RegulatedAssessment,
): { disposition: RegulatedAssessment["disposition"]; reasons: string[] } {
  const reasons: string[] = [];
  if (regulated.regulated) {
    reasons.push(...regulated.reasons);
    return { disposition: "hard_stop", reasons };
  }
  if (precheck.trademarkRisk === "high" || precheck.trademarkRisk === "medium" || !precheck.clearToProceed) {
    reasons.push(...precheck.trademarkNotes);
    if (!precheck.domainCollisions.some((d) => d.available)) reasons.push("no candidate domain is available");
    return { disposition: "owner_review", reasons };
  }
  return { disposition: "proceed", reasons };
}
