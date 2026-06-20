/**
 * Deliverable handoff helpers (#417) — **pure**, total, dependency-free. The bridge that makes the
 * #416 prompt's "@mention the right teammate in-channel" actually fire: when an agent's deliverable
 * @mentions a fleet teammate, we launch that teammate through the EXISTING governed a2a path
 * ({@link decideA2ACall}), so the handoff is depth/cycle/capability-bounded AND visibly narrated
 * in-channel by the #370 bridge.
 *
 * Premortem #200, structurally:
 *   - A fleet @handle pulled from the deliverable is **structural** — it is only ever matched against the
 *     workspace registry (`extractFleetMentions` filters to known handles) and used to target a governed
 *     a2a call; it can never widen scope or name a tool. The deliverable text itself becomes the target's
 *     `task` DATA, which `decideA2ACall` sanitizes/caps.
 *   - The **chain marker** ({@link HANDOFF_CHAIN_PREFIX}) is OUR prefix on the task WE assign to a launched
 *     session — it is never derived from agent free output. `parseHandoffChain` reads it back ONLY from a
 *     task we encoded, and only accepts well-formed handle tokens, so a poisoned deliverable cannot forge
 *     a chain that relaxes the depth/cycle guard.
 */

/** Mention/handle charset — the same gate `a2a.ts` and the subagent scope use. */
const HANDLE_TOKEN = "[A-Za-z0-9._-]+";

/** Scan body for `@handle` tokens. Global so we can collect every mention. */
const MENTION_RE = new RegExp(`@(${HANDLE_TOKEN})`, "g");

/**
 * The structural marker we prepend to a launched session's task to carry the a2a call chain to the next
 * hop. Exactly `[handoff-chain: a>b>c] `. WE control it; it is never read from agent output.
 */
export const HANDOFF_CHAIN_PREFIX = "[handoff-chain: ";

/** Matches a well-formed marker at the START of a task: `[handoff-chain: a>b>c] `. Captures the chain. */
const CHAIN_MARKER_RE = new RegExp(
  `^\\[handoff-chain: (${HANDLE_TOKEN}(?:>${HANDLE_TOKEN})*)\\] `,
);

/** A single handle token, anchored — used to validate every segment of a parsed chain. */
const HANDLE_ANCHORED_RE = new RegExp(`^${HANDLE_TOKEN}$`);

/**
 * Find the fleet @handles mentioned in `body`. Returns lowercased handles that appear in `knownHandles`
 * (compared lowercased), unique, in first-seen order. Pure + total — untrusted body in, structural
 * handle list out.
 */
export function extractFleetMentions(body: string, knownHandles: readonly string[]): string[] {
  const known = new Set(knownHandles.map((h) => h.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1]!.toLowerCase();
    if (known.has(handle) && !seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

/**
 * Encode the a2a call `chain` as a structural marker prefixed onto `task`. An empty chain returns the
 * task unchanged (byte-identical to today's manual a2a route). Pure + total.
 */
export function encodeHandoffGoal(chain: readonly string[], task: string): string {
  if (chain.length === 0) return task;
  return `${HANDOFF_CHAIN_PREFIX}${chain.join(">")}] ${task}`;
}

/**
 * Parse the call chain back out of a task we encoded with {@link encodeHandoffGoal}. Returns [] when the
 * marker is absent or malformed. Round-trips with `encodeHandoffGoal`; only accepts well-formed handle
 * tokens (defense-in-depth — the marker is ours, but we still validate it as DATA). Pure + total.
 */
export function parseHandoffChain(task: string): string[] {
  const match = CHAIN_MARKER_RE.exec(task);
  if (!match) return [];
  const chain = match[1]!.split(">");
  return chain.every((h) => HANDLE_ANCHORED_RE.test(h)) ? chain : [];
}
