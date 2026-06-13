import type { VoiceCategory } from "../voice/classify.js";

/**
 * The venture knowledge base (#190, ADR-0190) — **pure** answer assembly + KB-learning helpers. The KB is
 * the venture's OWN, trusted content (curated entries + distilled resolutions). A support answer is built
 * FROM the KB, never echoed from the customer's (untrusted) message — so the draft is grounded and the
 * routing gate can trust the `kbConfidence` it scores (premortem #200 §6).
 *
 * "With receipts" (AC2): every answer cites the KB entry ids it drew from. An answer with no matching
 * entry has `confidence: 0` and no receipts — which forces the routing gate to `escalate` (`unknown`),
 * so the desk never bluffs.
 */
export type KbSource = "manual" | "resolved_ticket";

export interface KbEntry {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  slug: string;
  title: string;
  body: string;
  category: string;
  source: KbSource;
  sourceTicketId: string | null;
  /** Provenance string — where this entry came from (the receipt's own receipt). */
  provenance: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnswerQuery {
  subject: string | null;
  body: string;
  category: VoiceCategory;
}

export interface KbAnswer {
  /** The drafted answer text assembled from the matched KB entries (empty when none matched). */
  draft: string;
  /** The cited KB entry ids — the receipts. */
  receipts: string[];
  /** Match confidence in [0,1]. 0 ⇒ no match ⇒ the routing gate escalates as `unknown`. */
  confidence: number;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "on", "for", "with", "my", "i",
  "you", "it", "this", "that", "how", "do", "does", "can", "i'm", "im", "we", "our", "your", "me",
]);

/** Tokenize into lowercased, de-punctuated, stop-word-free terms ≥ 3 chars. */
function terms(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/** Slugify a title into a stable per-workspace dedup key. */
export function kbSlug(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "untitled";
}

/**
 * Assemble a draft answer from the workspace's KB entries that best match the ticket. Pure + deterministic.
 * Scoring: a same-category entry gets a bias; term overlap (Jaccard-ish) drives the rest. Confidence is the
 * best entry's normalized score, clamped to [0,1]. Returns the top entries' bodies as the draft and their
 * ids as receipts. No match ⇒ `{ draft: "", receipts: [], confidence: 0 }`.
 */
export function buildAnswerWithReceipts(entries: KbEntry[], query: AnswerQuery, opts?: { maxEntries?: number }): KbAnswer {
  const maxEntries = opts?.maxEntries ?? 2;
  const queryTerms = new Set([...terms(query.subject ?? ""), ...terms(query.body)]);
  if (queryTerms.size === 0 || entries.length === 0) return { draft: "", receipts: [], confidence: 0 };

  const scored = entries
    .map((e) => {
      const entryTerms = new Set([...terms(e.title), ...terms(e.body), ...terms(e.category)]);
      let overlap = 0;
      for (const t of queryTerms) if (entryTerms.has(t)) overlap += 1;
      const union = new Set([...queryTerms, ...entryTerms]).size;
      const jaccard = union > 0 ? overlap / union : 0;
      const categoryBias = e.category === query.category ? 0.2 : 0;
      // Weight overlap fraction of the *query* terms heavily (an entry that covers the question scores high).
      const coverage = overlap / queryTerms.size;
      const score = Math.min(1, 0.6 * coverage + 0.2 * jaccard + categoryBias);
      return { entry: e, score, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { draft: "", receipts: [], confidence: 0 };

  const top = scored.slice(0, maxEntries);
  const draft = top.map((s) => s.entry.body.trim()).join("\n\n");
  const receipts = top.map((s) => s.entry.id);
  const confidence = Math.min(1, top[0]!.score);
  return { draft, receipts, confidence };
}

export interface ResolvedTicketForKb {
  id: string;
  workspaceId: string;
  ventureIdeaId: string | null;
  subject: string | null;
  body: string;
  category: VoiceCategory;
}

export interface NewKbEntry {
  workspaceId: string;
  ventureIdeaId: string | null;
  slug: string;
  title: string;
  body: string;
  category: string;
  source: KbSource;
  sourceTicketId: string | null;
  provenance: string;
}

/**
 * Distill a resolved ticket + its resolution into a new KB entry (AC4 — resolved tickets feed the KB).
 * Pure: produces the row the IO layer persists (deduped on `(workspace, slug)`), with provenance pointing
 * back at the source ticket so every future answer's receipt is itself traceable.
 */
export function kbEntryFromResolvedTicket(ticket: ResolvedTicketForKb, resolution: string): NewKbEntry {
  const title = (ticket.subject ?? ticket.body).trim().slice(0, 120) || `Resolved ticket ${ticket.id}`;
  return {
    workspaceId: ticket.workspaceId,
    ventureIdeaId: ticket.ventureIdeaId,
    slug: kbSlug(title),
    title,
    body: resolution.trim(),
    category: ticket.category,
    source: "resolved_ticket",
    sourceTicketId: ticket.id,
    provenance: `resolved_ticket:${ticket.id}`,
  };
}
