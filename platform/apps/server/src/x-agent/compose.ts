/**
 * The PURE compose core for the X agent (#596). No IO, no clock, no randomness — given the same brief + topic +
 * signal it always produces the same draft, so a test can assert that changing the input MEASURABLY changes the
 * output. The service/store/provider seams build on top of this.
 *
 * What it does:
 *   - composePost   — a calendar topic → one on-brand tweet (≤ {@link MAX_TWEET_CHARS}), approved hashtags appended
 *                     only while they fit.
 *   - composeThread — a topic + ordered points → a numbered thread, each tweet bounded, hashtags on the last.
 *   - composeReply  — an engagement target + the agent's drafted angle → a bounded @-addressed reply.
 *   - selectEngagementTargets — deterministically rank/cap a list of conversation signals by relevance.
 *
 * #200 DEFENSE (FM#6 — prompt injection): topics, angles, and especially the tweet text inside an
 * {@link EngagementSignal} are UNTRUSTED DATA. We sanitize every string (strip control chars, collapse
 * whitespace, bound length) and we NEVER copy a target tweet's prose into our reply — only its `tweetId` /
 * `authorHandle` are used structurally. A directive smuggled into a topic or a signal stays inert: it can only
 * become bounded display text, never an agent command, and it can never change which target gets selected.
 */

import type { EngagementSignal, XBrandBrief } from "./types.js";

/** X's per-tweet character budget. Every composed tweet is bounded to this. */
export const MAX_TWEET_CHARS = 280;

/** The most approved hashtags we will ever append to a single tweet (keeps drafts readable, not spammy). */
export const MAX_HASHTAGS = 3;

/**
 * Neutralize one untrusted string: strip control characters, collapse runs of whitespace, trim. Mirrors
 * `campaign-brief/brief.ts:sanitizeBriefValue` — defense-in-depth so raw input never reaches a draft unbounded.
 */
export function sanitizeText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars from untrusted input
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Sanitize `text` and truncate it to fit `max` characters, cutting at a word boundary where reasonable and
 * adding an ellipsis when truncation occurred. Always returns a string of length ≤ `max`.
 */
export function fitTweet(text: string, max: number = MAX_TWEET_CHARS): string {
  const clean = sanitizeText(text);
  if (clean.length <= max) return clean;
  if (max <= 1) return clean.slice(0, max);
  const room = max - 1; // reserve one char for the ellipsis
  let cut = clean.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  // Only snap to a word boundary if it does not throw away most of the tweet.
  if (lastSpace > Math.floor(room * 0.6)) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

/**
 * Normalize an approved hashtag list: sanitize, strip a leading '#', drop blanks/dupes (case-insensitive),
 * keep only hashtag-safe characters, and cap the count. The result is the ordered, de-duplicated tag set.
 */
export function normalizeHashtags(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw ?? []) {
    const tag = sanitizeText(r).replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/**
 * Append as many approved hashtags as fit within `max` (each as `#tag`, space-separated, after a single space).
 * Hashtags are added in order and only while the whole string stays within budget — so a long body simply gets
 * fewer (or no) tags rather than an over-length tweet. Pure and deterministic.
 */
export function appendHashtags(body: string, hashtags: readonly string[], max: number = MAX_TWEET_CHARS): string {
  let result = body;
  for (const tag of hashtags) {
    const candidate = `${result} #${tag}`;
    if (candidate.length > max) break;
    result = candidate;
  }
  return result;
}

/** Input to {@link composePost}. */
export interface ComposePostInput {
  /** The calendar topic / angle to post about (UNTRUSTED — sanitized + bounded here). */
  topic: string;
  brief?: XBrandBrief;
}

/**
 * Compose one on-brand tweet from a calendar topic. The body is the sanitized topic, bounded so there is room
 * to append the brief's approved hashtags; tags are added only while they fit. Throws on an empty topic — there
 * is nothing to post.
 */
export function composePost(input: ComposePostInput): { text: string } {
  const body = sanitizeText(input.topic);
  if (!body) throw new ComposeError("a topic is required to compose a post");
  const hashtags = normalizeHashtags(input.brief?.hashtags);
  // Reserve room for the hashtags so the fitted body + tags stays within one tweet.
  const reserve = hashtags.reduce((n, t) => n + t.length + 2, 0); // " #tag" per tag
  const fittedBody = fitTweet(body, Math.max(20, MAX_TWEET_CHARS - reserve));
  return { text: appendHashtags(fittedBody, hashtags) };
}

/** Input to {@link composeThread}. */
export interface ComposeThreadInput {
  /** The opening hook / topic of the thread (UNTRUSTED — sanitized + bounded). */
  topic: string;
  /** The ordered body points, one per tweet (UNTRUSTED — each sanitized + bounded). */
  points: string[];
  brief?: XBrandBrief;
}

/**
 * Compose a numbered thread: tweet 1 is the hook (the topic), tweets 2..N are the points, each prefixed
 * `i/N ` and bounded so the prefix + body fits one tweet. Approved hashtags are appended to the LAST tweet only
 * (so the thread is tagged once, not spammed). Blank points are dropped. Throws if nothing composable remains.
 */
export function composeThread(input: ComposeThreadInput): { tweets: string[] } {
  const hook = sanitizeText(input.topic);
  const points = input.points.map(sanitizeText).filter((p) => p.length > 0);
  const parts = [hook, ...points].filter((p) => p.length > 0);
  if (parts.length === 0) throw new ComposeError("a thread needs at least a topic or one point");

  const total = parts.length;
  const hashtags = normalizeHashtags(input.brief?.hashtags);
  const tweets: string[] = parts.map((part, i) => {
    const prefix = `${i + 1}/${total} `;
    const isLast = i === total - 1;
    const reserve = isLast ? hashtags.reduce((n, t) => n + t.length + 2, 0) : 0;
    const body = fitTweet(part, Math.max(10, MAX_TWEET_CHARS - prefix.length - reserve));
    const withPrefix = `${prefix}${body}`;
    return isLast ? appendHashtags(withPrefix, hashtags) : withPrefix;
  });
  return { tweets };
}

/** Input to {@link composeReply}. */
export interface ComposeReplyInput {
  /** The conversation to engage — only `tweetId` / `authorHandle` are used (its `text` is never echoed). */
  signal: EngagementSignal;
  /**
   * The agent's drafted response point (on-brand DATA the agent authored). When absent, the brief's positioning
   * is used; when both are absent a neutral acknowledgement is used. UNTRUSTED — sanitized + bounded.
   */
  angle?: string;
  brief?: XBrandBrief;
}

/**
 * Compose a reply to a relevant conversation. Structurally addresses the author (`@handle`) and carries the
 * agent's `angle` (or the brief's positioning) — it deliberately does NOT quote or paraphrase the target
 * tweet's prose, so untrusted conversation text can never leak into (or hijack) our reply (#200 FM#6). The
 * reply is bounded to one tweet; approved hashtags are appended while they fit.
 */
export function composeReply(input: ComposeReplyInput): { text: string; targetTweetId: string } {
  const tweetId = sanitizeText(input.signal.tweetId);
  if (!tweetId) throw new ComposeError("an engagement signal needs a tweetId to reply to");
  const handle = sanitizeText(input.signal.authorHandle ?? "").replace(/^@+/, "").replace(/[^A-Za-z0-9_]/g, "");
  const angle = sanitizeText(input.angle ?? input.brief?.positioning ?? "Thanks for sharing — great point.");
  const mention = handle ? `@${handle} ` : "";
  const hashtags = normalizeHashtags(input.brief?.hashtags);
  const reserve = hashtags.reduce((n, t) => n + t.length + 2, 0);
  const body = fitTweet(`${mention}${angle}`, Math.max(20, MAX_TWEET_CHARS - reserve));
  return { text: appendHashtags(body, hashtags), targetTweetId: tweetId };
}

/** Options for {@link selectEngagementTargets}. */
export interface SelectEngagementOptions {
  /** Keep only signals whose `relevance` is ≥ this threshold (default 0 — keep all). */
  minRelevance?: number;
  /** Cap the number of returned targets (default: no cap). */
  max?: number;
}

/**
 * Deterministically rank a list of conversation signals and return the most relevant, capped. Pure: filters by
 * `minRelevance`, sorts by `relevance` descending with `tweetId` as a stable tiebreaker, and truncates to
 * `max`. Signals missing a `tweetId` are dropped (nothing to engage). This is how the agent decides WHICH
 * conversations to draft engagement for — based only on the numeric score, never the untrusted tweet prose.
 */
export function selectEngagementTargets(
  signals: readonly EngagementSignal[],
  opts: SelectEngagementOptions = {},
): EngagementSignal[] {
  const min = opts.minRelevance ?? 0;
  const filtered = signals.filter((s) => sanitizeText(s.tweetId) !== "" && (s.relevance ?? 0) >= min);
  const sorted = [...filtered].sort(
    (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || a.tweetId.localeCompare(b.tweetId),
  );
  return opts.max !== undefined ? sorted.slice(0, Math.max(0, opts.max)) : sorted;
}

/** A compose call rejected for a stated reason (mapped to 4xx at any route layer). */
export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}
