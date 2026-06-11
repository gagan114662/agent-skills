import { dedupeKey as memoryDedupeKey } from "../memory/dedupe.js";
import type { EvidenceRef } from "./types.js";

/**
 * Pure dedupe for the Insight Miner (#100). The rule (decision 4 of ADR-0100): **killed angles never
 * return UNCITED.** The venture loop records KILL verdicts to the #15 memory graph; before promoting
 * an insight we check whether its dedupe key matches a recorded kill AND the insight is uncited. A
 * killed angle that now carries a real citation is allowed back — new evidence may reopen a question,
 * but the LLM may not re-propose the same uncited consensus idea the loop already rejected.
 */

/**
 * The killed-angle handle: reuse the #15 `dedupeKey` (type tag `insight`, no entity) so the same
 * statement resolves to one node regardless of source, matching how a KILL is recorded.
 */
export function insightDedupeKey(statement: string): string {
  return memoryDedupeKey("insight", statement, null);
}

/** True iff the insight carries at least one sourced citation (a non-blank source URL). */
export function isCited(evidence: readonly EvidenceRef[]): boolean {
  return evidence.some((e) => !!e.sourceUrl && e.sourceUrl.trim().length > 0);
}

/**
 * Suppress iff the dedupe key was KILLed AND the insight is uncited. Accepts either a Set or an array
 * of killed keys.
 */
export function suppressedByKill(input: {
  dedupeKey: string;
  killedKeys: ReadonlySet<string> | readonly string[];
  cited: boolean;
}): boolean {
  const killed = new Set(input.killedKeys);
  return killed.has(input.dedupeKey) && !input.cited;
}
