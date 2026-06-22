/**
 * The value-first drafting core for the community participation agent (issue #597). Pure: `draftReply` is a
 * deterministic function of its inputs — same thread + context in, same {@link ParticipationDraft} out. No
 * clock, no randomness, no IO. (Real LLM-authored drafting is a future provider; the deterministic template here
 * keeps the default offline and the tests reproducible.)
 *
 * Two acceptance criteria are enforced structurally here:
 *   - The reply is helpful-FIRST: the value content always leads; a product mention, when present, is a short
 *     tail, never the substance.
 *   - The product is mentioned ONLY when the thread is genuinely relevant (relevance ≥
 *     {@link AntiSpamPolicy.productMentionRelevance}), and whenever it is mentioned the affiliation disclosure is
 *     appended. "Mention ⇒ disclose" is invariant: there is no code path that mentions without disclosing.
 *
 * Relevance is computed from the thread's STRUCTURAL `topics` (provider-normalized tags), never from its
 * untrusted title/body prose — so the mention/relevance decision cannot be steered by a poisoned thread (#200 §6).
 */

import type { AntiSpamPolicy } from "./caps.js";
import type { CommunityThread, ParticipationDraft } from "./types.js";

/** Who we are when we participate — the product details and the affiliation disclosure line. */
export interface ProductContext {
  /** Display name, e.g. "ipop.ai". */
  name: string;
  /** Link to the product, e.g. "https://ipop.ai". */
  url: string;
  /** Our domain / solution topics, used to score a thread's relevance (matched against the thread's topics). */
  topics: string[];
  /** The affiliation disclosure appended whenever the reply mentions the product (the issue's hard requirement). */
  disclosure: string;
}

/** Context for one drafting call. */
export interface DraftContext {
  product: ProductContext;
  /**
   * Optional concrete, genuinely-helpful points to make (each becomes a sentence). When omitted, a deterministic
   * on-topic helper is generated from the matched topics so the reply is still value-first.
   */
  helpfulPoints?: string[];
  policy: AntiSpamPolicy;
}

/** Lowercase + trim + dedupe a topic list so relevance is order- and case-insensitive. */
function normalizeTopics(topics: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const t of topics) {
    const n = t.trim().toLowerCase();
    if (n.length > 0) seen.add(n);
  }
  return [...seen];
}

/**
 * Relevance of a thread to our domain, 0..1: the fraction of the THREAD's topics that overlap ours. The thread
 * defines the denominator, so a long product-topic list never dilutes the score, and a thread entirely about
 * things we know scores 1.0. A thread with no topics scores 0 (nothing to be relevant to).
 */
export function computeRelevance(threadTopics: readonly string[], productTopics: readonly string[]): number {
  const tt = normalizeTopics(threadTopics);
  if (tt.length === 0) return 0;
  const pt = new Set(normalizeTopics(productTopics));
  let overlap = 0;
  for (const t of tt) if (pt.has(t)) overlap += 1;
  return overlap / tt.length;
}

/** The matched topics between a thread and our domain (lowercased), preserving the thread's order. */
function matchedTopics(threadTopics: readonly string[], productTopics: readonly string[]): string[] {
  const pt = new Set(normalizeTopics(productTopics));
  return normalizeTopics(threadTopics).filter((t) => pt.has(t));
}

/** Does `body` contain the disclosure marker? Case-insensitive so casing can never defeat the check (fail-closed). */
export function containsDisclosure(body: string, disclosure: string): boolean {
  const needle = disclosure.trim().toLowerCase();
  if (needle.length === 0) return false;
  return body.toLowerCase().includes(needle);
}

/** Build the helpful, value-first lead of the reply. Always present; never about the product. */
function buildHelpfulBody(thread: CommunityThread, ctx: DraftContext): string {
  const points = (ctx.helpfulPoints ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  if (points.length > 0) {
    // Each helpful point as its own sentence — substance leads.
    return points.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ");
  }
  // No explicit points: synthesize an on-topic, genuinely-useful opener from the matched topics.
  const matches = matchedTopics(thread.topics, ctx.product.topics);
  const focus = matches.length > 0 ? matches.join(", ") : "this";
  return (
    `Happy to share what has worked for teams tackling ${focus}: start by writing down the outcome you ` +
    `actually want, instrument the few steps that lead to it, then iterate on the single biggest drop-off ` +
    `before adding anything new. Most of the win is in measuring honestly and cutting scope, not tooling.`
  );
}

/**
 * Draft a value-first reply for a thread. The body always leads with helpful content; a product mention is
 * appended ONLY when the thread is strongly relevant, and a mention always carries the disclosure.
 */
export function draftReply(thread: CommunityThread, ctx: DraftContext): ParticipationDraft {
  const relevance = computeRelevance(thread.topics, ctx.product.topics);
  const helpful = buildHelpfulBody(thread, ctx);

  const mentionsProduct = relevance >= ctx.policy.productMentionRelevance;
  let body = helpful;
  if (mentionsProduct) {
    // Short, relevant tail + mandatory affiliation disclosure. Help first; the product is a footnote.
    body = `${helpful} If it is useful, ${ctx.product.name} (${ctx.product.url}) handles a chunk of this. ${ctx.product.disclosure}`;
  }

  return {
    body,
    mentionsProduct,
    hasDisclosure: mentionsProduct ? containsDisclosure(body, ctx.product.disclosure) : false,
    relevance,
  };
}
