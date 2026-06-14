import type { PublicSource, ReadResult } from "./types.js";

/**
 * The QUARANTINED enrichment reader (#223 / #200 premortem injection defense).
 *
 * An implementation reads ONE public source and returns structured DATA (a {@link ReadResult}) — never
 * instructions, never an action. By construction this interface exposes NO send / spend / gate capability:
 * an implementation literally cannot email, post, deploy, or charge. That is the hard separation between
 * the read-only enrichment agent and any outreach/send agent — it is **structural**, not a convention a
 * caller might forget. A poisoned profile or post is data flowing out of `read()`; it can reach a human in
 * a brief, but it can never reach an action.
 */
export interface QuarantinedProfileReader {
  read(source: PublicSource): Promise<ReadResult>;
}

/** Max characters of source text quoted into a brief (minimal data — a citation, not a dossier). */
export const MAX_EXCERPT_CHARS = 280;
/** Max topic tags surfaced per source. */
export const MAX_SIGNALS = 8;
/** Max characters per topic tag. */
export const MAX_SIGNAL_CHARS = 40;

/**
 * Neutralize fetched public text into safe citation data: strip control characters, collapse whitespace,
 * truncate. DEFENSE-IN-DEPTH — even though the brief never parses this text for directives, we never store
 * or surface raw unbounded scraped content. The result is only ever a quoted excerpt.
 */
export function sanitizeExcerpt(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- intentionally stripping control chars from scraped text
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXCERPT_CHARS);
}

/** Normalize a raw topic token into a bounded, safe signal (lowercase, safe charset, length-capped). */
export function sanitizeSignal(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9 +#./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIGNAL_CHARS);
}

/** Normalize + dedupe + cap a list of raw topic tokens. */
export function sanitizeSignals(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const s = sanitizeSignal(r);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SIGNALS) break;
  }
  return out;
}

/** Stopwords excluded from derived topic tags — keeps `caresAbout` to substantive nouns, not filler. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are", "was", "were", "our",
  "your", "you", "they", "them", "their", "about", "into", "just", "what", "when", "will", "would",
  "been", "being", "than", "then", "there", "here", "over", "more", "most", "some", "such", "very",
  "ignore", "previous", "instructions", "instruction", "please", "now", "send", "email",
]);

/**
 * Derive bounded topic tags from public text — a tiny frequency-based keyword pick over substantive
 * tokens. This is **topic extraction, not comprehension**: the tokens become opaque chips in the brief,
 * never instructions. (Common imperative/injection filler is in {@link STOPWORDS} so it doesn't surface as
 * a "cares about" topic, but the real defense is architectural: a topic tag can never trigger an action.)
 */
export function deriveSignals(text: string): string[] {
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().split(/[^a-z0-9+#./-]+/)) {
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SIGNALS)
    .map(([token]) => token);
}

/**
 * The default, no-network reader. It treats the public text the discovery layer (#222) already fetched as
 * the read content: a source is "actually read" (`ok: true`) iff it carries non-empty `fetchedText`. A
 * source with no fetched text was NOT read → its hook is later rejected (the video's "did you read it?"
 * gate). A live reader (the quarantined #174 browser) would fetch the URL here instead; the contract —
 * DATA out, zero send/spend capability — is identical, which is the whole point of the seam.
 */
export class StaticProfileReader implements QuarantinedProfileReader {
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async read(source: PublicSource): Promise<ReadResult> {
    const text = (source.fetchedText ?? "").trim();
    const ok = text.length > 0;
    return {
      sourceId: source.id,
      url: source.url,
      kind: source.kind,
      ok,
      retrievedAt: source.fetchedAt ?? this.now().toISOString(),
      excerpt: ok ? sanitizeExcerpt(text) : "",
      signals: ok ? sanitizeSignals(deriveSignals(text)) : [],
    };
  }
}
