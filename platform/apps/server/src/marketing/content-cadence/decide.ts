import { renderKeywordPrevalidation, type KeywordPrevalidationSignal } from "./prevalidation.js";

/**
 * #416 (with #415) — the missing CADENCE BRAIN.
 *
 * The publish chain is complete and proven: a briefed agent drafts → the draft surfaces as an
 * `agent.deliverable` card in the #13 queue → the owner approves → the `site_pr` adapter (#364) opens a
 * REAL on-site content PR via the #250 actuator → durable receipt + #386 attribution. What was MISSING is
 * a *source of fresh objectives*: the fleet only acts on a human @mention/brief, so left alone it re-audits
 * the same homepage forever (#416) and never ships a new asset (#415). There is no keyword/target-query
 * table and no engine that hands the fleet the next thing to write.
 *
 * This module is the pure brain that closes that loop: given an owner-configured list of target queries
 * and the current day, it picks the next query (round-robin so the calendar keeps moving) and composes a
 * brief that tells the fleet to PRODUCE AND PUBLISH — not audit. The engine ({@link ContentCadenceEngine})
 * runs it on a timer and launches it through the existing {@link MarketingBriefService}; the draft then
 * flows the already-built #13 → `site_pr` path. Default-OFF + owner-first, exactly like delivery (#295).
 *
 * Pure: no IO, no clock (the engine injects `now`). Every branch is unit-tested.
 */

/** The content lead whose department (`content`) routes to the on-site publish channel (#364). */
// The cadence now starts the chain with Scout (research), who hands off to Quill (writing) — so the fleet
// visibly COORDINATES (a real Scout→Quill handoff) instead of each agent working in a silo (#359/#417).
export const DEFAULT_CADENCE_LEAD = "scout";

/** Owner-configured cadence block (mirrors `deliverySchema`'s default-OFF + owner-first shape). */
export interface ContentCadenceConfigInput {
  /** Master switch — default OFF. Nothing briefs unless this is explicitly true. */
  enabled?: boolean;
  /** Default true: only the owner workspace runs the cadence (owner-first rollout). */
  ownerWorkspaceOnly?: boolean;
  /** The owner workspace id; when `ownerWorkspaceOnly`, only this workspace is in scope. */
  ownerWorkspaceId?: string;
  /** The editorial calendar: the target search queries the fleet writes+publishes for, in order. */
  queries?: string[];
  /** Which department lead receives the brief (defaults to the content lead, {@link DEFAULT_CADENCE_LEAD}). */
  lead?: string;
}

export interface ContentCadenceFlags {
  /** True only when the cadence is enabled AND this workspace is in scope. */
  enabled: boolean;
  /** The non-empty, trimmed, de-duplicated query calendar (empty ⇒ nothing to brief). */
  queries: string[];
  /** The resolved lead handle. */
  lead: string;
}

const FLAGS_OFF: ContentCadenceFlags = { enabled: false, queries: [], lead: DEFAULT_CADENCE_LEAD };

/**
 * Resolve the per-workspace cadence flags. Fail-closed: any missing/false master switch, or a workspace
 * out of the owner-first scope, yields a disabled result with no queries — so prod with the block unset is
 * byte-for-byte unchanged (the engine no-ops). Queries are trimmed + de-duplicated (order preserved) and
 * blanks dropped, so a sloppy config can never brief an empty goal.
 */
export function resolveContentCadenceFlags(
  config: ContentCadenceConfigInput | undefined,
  workspaceId: string,
): ContentCadenceFlags {
  if (!config || config.enabled !== true) return FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  if (ownerOnly && config.ownerWorkspaceId !== workspaceId) return FLAGS_OFF;

  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of config.queries ?? []) {
    const q = raw.trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      queries.push(q);
    }
  }
  if (queries.length === 0) return FLAGS_OFF;
  const lead =
    (config.lead ?? DEFAULT_CADENCE_LEAD).trim().replace(/^@/, "").toLowerCase() ||
    DEFAULT_CADENCE_LEAD;
  return { enabled: true, queries, lead };
}

/** The day bucket used both to ROTATE the calendar and as the once-per-day watermark. */
export function cadenceDayNumber(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/**
 * Pick the query for a given day by round-robin, so the editorial calendar advances one target per period
 * and cycles back rather than fixating on a single query (the #416 re-audit failure). Returns null only
 * when there are no queries.
 */
export function selectCadenceQuery(queries: readonly string[], dayNumber: number): string | null {
  if (queries.length === 0) return null;
  // Guard against a negative day (clock seam in tests) so the modulo index is always in range.
  const idx = ((dayNumber % queries.length) + queries.length) % queries.length;
  return queries[idx] ?? null;
}

/**
 * Compose the brief goal. Critically (#415) it tells the fleet to WRITE a focused on-site post that targets
 * the query — not an audit. The decisive detail (learned from live PR #453): the agent's FINAL MESSAGE is
 * what ships verbatim as the published `.md`, so the brief must demand the COMPLETE post as the output —
 * NOT a chat summary "describing" a draft, NOT files staged in the session (they're lost), NOT a request to
 * open a PR (the agent can't; the platform opens it). The query is owner-authored DATA after a fixed prefix;
 * publishing is handled downstream, so the agent only has to produce the post body.
 */
export function composeContentBrief(
  query: string,
  prevalidation?: KeywordPrevalidationSignal,
): string {
  const q = query.trim().replace(/\s+/g, " ");
  const validationBlock = prevalidation
    ? `${renderKeywordPrevalidation(prevalidation)}\n\n`
    : "SEO pre-publication validation:\n" +
      "- verdict: unvalidated\n" +
      "- summary: No SERP, volume, intent, or rank proof was available before this brief.\n\n";
  // A COORDINATED brief (#359/#417): Scout does the research, then hands off to Quill to write — so the team
  // visibly works together. The closing "@quill …" line is what fires the #417 handoff (the deliverable is
  // scanned for @mentions), launching Quill with this context. Quill's brief (the second half) tells it to
  // OUTPUT the complete post as its message (the live PR #453 lesson) — that post is what publishes.
  return (
    `${validationBlock}` +
    `@scout: research the search query "${q}" — the search intent, the angle competitors miss, and the 3-5 ` +
    `points a genuinely useful post must hit. First, validate winnability: SERP shape, estimated volume, ` +
    `audience/ICP fit, and whether this site has a realistic path to page one. If the validation verdict above ` +
    `is not "validated", call out the risk clearly for the owner before the writing handoff. Keep it short ` +
    `(a tight brief, not an audit). Then hand off to ` +
    `your teammate so the post actually gets written:\n\n` +
    `@quill: using Scout's brief above, write a focused, genuinely useful blog post that targets "${q}". ` +
    `Output the COMPLETE post as your final message — a markdown H1 title line ("# …") then the full body ` +
    `(~800-1200 words). Write the actual post, not an outline or summary. Do NOT stage files or open a PR — ` +
    `your final message IS the post and the platform publishes it automatically. Ship a solid B-plus post.`
  );
}
