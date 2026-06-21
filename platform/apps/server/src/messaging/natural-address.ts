/**
 * Natural addressing (#471) — pure, dependency-free.
 *
 * A product sold as "autonomous agents" should not require a perfectly-typed `@mention` to get a teammate's
 * attention. This turns a *clearly directed* plain-text address into the same candidate handle tokens the
 * `@mention` parser produces, so "Scout, can you…" / "ask Scout to…" / "QA test for scout:" pick the agent up
 * exactly like "@scout" does.
 *
 * SAFETY — false positives launch real (cost-bearing) sessions, so detection is deliberately CONSERVATIVE in
 * two independent ways:
 *   1. Only *directed* grammatical forms fire here (a leading address before a comma/colon, or an explicit
 *      directive verb like ask/tell/hey/cc/for + name). A bare mention of a name in prose ("scout out the
 *      competition", "for the record") never matches.
 *   2. This only yields candidate TOKENS. Resolution (token → real member by display name, scoped to the
 *      workspace) is the hard filter: a token that isn't an actual teammate's name resolves to nothing and
 *      launches nothing. So a stray word that slips through (1) is dropped at resolution.
 *
 * Tokens are lowercased and de-duplicated, first-appearance order — same contract as {@link parseMentionTokens}
 * so the two sets compose cleanly.
 */

/** A handle/name shape: a letter, then word-ish chars. Bounded so a runaway match can't scan a whole word salad. */
const NAME = "[A-Za-z][A-Za-z0-9._-]{1,30}";

/**
 * A leading address: the message opens by naming someone, then a comma or colon.
 *   "Scout, can you crawl the homepage?"  → scout
 *   "scout: quick one"                    → scout
 * Anchored at start so it never matches a name mid-sentence (that prose is not an address).
 */
const LEADING_ADDRESS = new RegExp(`^\\s*(${NAME})\\s*[,:]`);

/**
 * A directive address: an explicit "talking-to-you" verb immediately followed by the name.
 *   "ask Scout to audit the blog"   → scout
 *   "QA test for scout: …"          → scout
 *   "hey quill can you draft this"  → quill
 * The verb must be on a word boundary (so "basketball" doesn't yield "ketball") and the name must end at a
 * boundary (whitespace / punctuation / end) so we capture the whole name, not a prefix.
 */
const DIRECTIVE_ADDRESS = new RegExp(`\\b(?:ask|tell|hey|cc|for|have|get)\\s+(${NAME})(?=[\\s,.:;!?]|$)`, "gi");

/**
 * Candidate handle tokens from *directed* plain-text addressing in `body`. Conservative by design (see file
 * header): returns [] for ordinary prose that merely contains a name. Lowercased, de-duplicated, in order.
 */
export function detectDirectedHandles(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const token = raw.toLowerCase();
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };

  const leading = LEADING_ADDRESS.exec(body);
  if (leading) add(leading[1]);

  for (const m of body.matchAll(DIRECTIVE_ADDRESS)) add(m[1]);

  return out;
}
