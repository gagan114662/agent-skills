/**
 * Brand + factual-accuracy publish gate (issue #627) — module barrel. Import everything from here.
 *
 * THE RULE this module makes enforceable: nothing outbound/public ships until it has passed BOTH a
 * brand-voice check and a factual-accuracy (source-citation) check. The pieces compose into one call a
 * publisher should make at every public egress (post / email / social / landing page):
 *
 *   1. Resolve the brand context once:           const brief = await briefService.get(workspaceId);   // #588
 *   2. Gate the draft before any public action:  const d = gatePublishForBrief(draft, brief);
 *   3. Branch on the verdict:                     if (!d.allowed) routeBackForRevision(d.revisionNotes);
 *                                                 else publish(draft);   // still subject to the #13 queue for sends
 *
 * The two axes are independent (defense-in-depth): the voice check can pass a draft the fact check blocks and
 * vice-versa; a draft must clear BOTH. Both are heuristic and over-report — a false positive costs one
 * revision, a false negative ships off-brand or unsourced content, so the gate leans strict.
 *
 * Nothing here does IO or wires into a route / registry / migration / schema barrel — it is a pure library
 * other modules call, exactly like content-guard (#674). It reads the campaign brief (#588) as input but does
 * not own or mutate it. That self-containment is why the #627 change set touches no DB migration, schema
 * barrel, or app-wiring file.
 */

import { resolvePublishGatePolicy } from "./caps.js";
import { gatePublish, type PublishDecision } from "./gate.js";
import { type BrandVoiceProfile } from "./voice.js";

export * from "./voice.js";
export * from "./facts.js";
export * from "./gate.js";
export { resolvePublishGatePolicy } from "./caps.js";

/**
 * The minimal shape of the campaign brief (#588) this gate reads. Declared structurally (not imported) so the
 * gate stays a leaf with zero coupling to the campaign-brief module's wiring — any object with these fields
 * works, and the real `CampaignBrief` satisfies it.
 */
export interface BrandContext {
  /** Brand-voice direction (currently advisory context; the lexicon + banned phrases do the enforcing). */
  voice?: string;
  /** Hard limits the fleet must respect — mined for banned phrases (e.g. `never say "guaranteed results"`). */
  constraints?: readonly string[];
  /** The APPROVED claims an agent may make — these need no external citation (the fact-check allowlist). */
  brandClaims?: readonly string[];
}

/** Max banned phrases derived from a brief's constraints (a focusing tool, not an unbounded blocklist). */
export const MAX_DERIVED_BANNED_PHRASES = 24;

/**
 * Build a {@link BrandVoiceProfile} from a campaign brief (#588). The brief's `constraints` are owner-authored
 * prose, so we extract the enforceable, literal parts:
 *  - any text the owner QUOTED inside a constraint (`never say "guaranteed results"` ⇒ banned `guaranteed results`);
 *  - the trailing phrase of a negative constraint (`no competitor names` ⇒ banned `competitor names`).
 * Everything is trimmed, de-duplicated, length-bounded and capped. Semantic constraints that can't be reduced
 * to a literal phrase (e.g. "keep it concise") simply contribute nothing — the gate degrades gracefully.
 */
export function profileFromBrief(brief: BrandContext | null | undefined): BrandVoiceProfile {
  const constraints = brief?.constraints ?? [];
  const banned: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const phrase = raw.replace(/\s+/g, " ").trim();
    if (phrase.length < 3 || phrase.length > 80) return;
    const key = phrase.toLowerCase();
    if (seen.has(key) || banned.length >= MAX_DERIVED_BANNED_PHRASES) return;
    seen.add(key);
    banned.push(phrase);
  };

  for (const c of constraints) {
    if (typeof c !== "string") continue;
    // 1. Quoted segments (single, double, or smart quotes) are the strongest signal.
    for (const m of c.matchAll(/["'“”‘’]([^"'“”‘’]{2,})["'“”‘’]/g)) {
      if (m[1]) add(m[1]);
    }
    // 2. Negative constraint → trailing phrase. Strip a leading negation + optional filler verb.
    const neg =
      /^\s*(?:no|never|avoid|don'?t|do\s+not|without|don'?t\s+use|no\s+more)\b[\s:,-]*(?:say(?:ing)?|use|using|mention(?:ing)?|promis(?:e|ing)|claim(?:ing)?|includ(?:e|ing)|writ(?:e|ing))?\b[\s:,-]*(.+)$/i.exec(
        c,
      );
    if (neg && neg[1]) {
      // Drop trailing soft words so "no competitor names anywhere" → "competitor names anywhere" stays usable.
      add(neg[1].replace(/[.!?;:,]+$/, ""));
    }
  }
  return { bannedPhrases: banned };
}

/**
 * One-call convenience: gate a draft against a campaign brief (#588) using the env-resolved policy. Derives
 * the brand-voice profile (banned phrases) and the approved-claims allowlist from the brief, so a publisher
 * never has to assemble them by hand. Accepts a `null` brief (an unconfigured workspace) — only the built-in
 * off-brand lexicon and source-presence checks apply, which is exactly the guard the runaway session lacked.
 */
export function gatePublishForBrief(
  content: string,
  brief: BrandContext | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PublishDecision {
  return gatePublish(
    {
      content,
      voiceProfile: profileFromBrief(brief),
      approvedClaims: (brief?.brandClaims ?? []).filter((c): c is string => typeof c === "string"),
    },
    resolvePublishGatePolicy(env),
  );
}
