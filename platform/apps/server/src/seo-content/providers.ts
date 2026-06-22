/**
 * Provider seams and implementations for the SEO content pipeline (issue #598).
 *
 * Five seams, one per stage's external dependency:
 *   - {@link KeywordProvider}  — keyword research (volume/difficulty/intent).
 *   - {@link BriefProvider}    — turns a validated keyword into a content brief.
 *   - {@link DraftProvider}    — turns a brief into a draft.
 *   - {@link PublishProvider}  — publishes an approved draft to a CMS (side-effectful).
 *   - {@link IndexProvider}    — pings search engines to index a published URL (side-effectful).
 *
 * Two layers ship here:
 *   1. The deterministic FAKES ({@link FakeKeywordProvider} …), which are the production DEFAULT. They do no
 *      network IO: every output is a stable function of the input (FNV-1a hashing), so enabling the module
 *      exercises the whole keyword → brief → draft → publish → index-ping path WITHOUT a single live call or real
 *      publish. That is what makes "no external calls until a real transport is wired" structural, not a promise.
 *   2. Real scaffolds ({@link RealPublishProvider}, {@link RealIndexProvider}) that forward to an injected
 *      transport. No transport is wired in this change set, so even with the master switch ON and a credential
 *      present, publish/index are recorded no-ops ("no transport configured"); with NO credential they are no-ops
 *      ("no credentials") — never an OAuth attempt, since this module never collects passwords.
 */

import type {
  ContentBrief,
  ContentDraft,
  IndexPingInput,
  IndexPingResult,
  KeywordMetrics,
  PublishInput,
  PublishResult,
  SearchIntent,
} from "./types.js";
import { SEARCH_INTENTS } from "./types.js";

// --- Seams ---------------------------------------------------------------------------------------------------

/** Researches a candidate keyword for the run's topic. */
export interface KeywordProvider {
  research(input: { topic: string; keyword: string }): Promise<KeywordMetrics>;
}

/** Generates a content brief from a validated keyword + topic. */
export interface BriefProvider {
  generate(input: { keyword: string; topic: string }): Promise<ContentBrief>;
}

/** Generates a draft from a content brief. */
export interface DraftProvider {
  generate(input: { brief: ContentBrief }): Promise<ContentDraft>;
}

/** Publishes an approved draft to a CMS, returning the live URL (side-effectful in a real adapter). */
export interface PublishProvider {
  publish(input: PublishInput): Promise<PublishResult>;
}

/** Submits a published URL for indexing, returning a receipt (side-effectful in a real adapter). */
export interface IndexProvider {
  ping(input: IndexPingInput): Promise<IndexPingResult>;
}

/** The full registry of providers the service routes through. */
export interface PipelineProviders {
  keyword: KeywordProvider;
  brief: BriefProvider;
  draft: DraftProvider;
  publish: PublishProvider;
  index: IndexProvider;
}

// --- Deterministic hashing (no RNG, no clock) ----------------------------------------------------------------

/** Deterministic FNV-1a → 32-bit unsigned hash of a string. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A stable hex token derived from the parts — used for fake URLs / receipt ids. */
function stableHex(parts: readonly string[]): string {
  return fnv1a(parts.join("")).toString(16).padStart(8, "0");
}

// --- Fake (default) providers --------------------------------------------------------------------------------

/**
 * Deterministic keyword research. Volume, difficulty, and intent are stable functions of the keyword string, so
 * the same keyword always yields the same metrics. Tuned so a normal keyword clears the default gate thresholds.
 */
export class FakeKeywordProvider implements KeywordProvider {
  async research(input: { topic: string; keyword: string }): Promise<KeywordMetrics> {
    const keyword = input.keyword.trim();
    const h = fnv1a(keyword.toLowerCase());
    // Volume in [500, 8500], difficulty in [10, 60] — both comfortably inside the conservative defaults.
    const monthlyVolume = keyword.length === 0 ? 0 : 500 + (h % 8000);
    const difficulty = 10 + ((h >> 8) % 51);
    const intent: SearchIntent = SEARCH_INTENTS[(h >> 16) % SEARCH_INTENTS.length] ?? "informational";
    return { keyword, monthlyVolume, difficulty, intent };
  }
}

/**
 * Deterministic brief generation. Produces a complete, gate-passing brief: a title, the keyword as the primary
 * keyword, an audience, four outline sections, and a sensible word target — all derived from the keyword.
 */
export class FakeBriefProvider implements BriefProvider {
  async generate(input: { keyword: string; topic: string }): Promise<ContentBrief> {
    const keyword = input.keyword.trim();
    return {
      title: `The Practical Guide to ${keyword}`,
      primaryKeyword: keyword,
      audience: `teams evaluating ${input.topic.trim() || keyword}`,
      outline: [
        { heading: `What ${keyword} actually means`, summary: `Define ${keyword} without the jargon.` },
        { heading: `When ${keyword} is worth it`, summary: `The situations where it pays off.` },
        { heading: `How to get started`, summary: `A concrete first-week plan.` },
        { heading: `Common mistakes`, summary: `What to avoid and why.` },
      ],
      wordTarget: 900,
    };
  }
}

/**
 * Deterministic draft generation. Produces an on-brand, fully-sourced draft that clears the brand + fact gate: a
 * title and keyword-bearing body well past the word floor, with two sourced claims. No banned filler phrases.
 */
export class FakeDraftProvider implements DraftProvider {
  async generate(input: { brief: ContentBrief }): Promise<ContentDraft> {
    const { brief } = input;
    const kw = brief.primaryKeyword.trim();
    const sentences: string[] = [
      `${kw} is easier to reason about once you separate the outcome you want from the tactics you reach for.`,
      ...brief.outline.map(
        (s) =>
          `${s.heading}: ${s.summary} In practice, ${kw} rewards teams who measure honestly, ` +
          `cut scope early, and ship the smallest useful version before adding anything new.`,
      ),
    ];
    // Pad deterministically until the body comfortably clears the brief's word target — the fake must produce a
    // draft that actually passes the brand gate's substance floor, not a stub that the gate rightly rejects.
    const filler =
      `The throughline for ${kw} is the same everywhere: pick one metric, instrument the few steps that ` +
      `move it, and iterate on the single biggest drop-off so the work compounds instead of sprawling.`;
    const countWords = (t: string): number => t.trim().split(/\s+/).filter((w) => w.length > 0).length;
    while (countWords(sentences.join(" ")) < brief.wordTarget + 20) sentences.push(filler);
    const body = sentences.join(" ");
    const slug = stableHex([kw]);
    return {
      title: `${brief.title}: a field-tested approach`,
      body,
      wordCount: body.trim().split(/\s+/).filter((w) => w.length > 0).length,
      claims: [
        { text: `Teams that measure a single metric iterate faster on ${kw}.`, sourceUrl: `https://example.test/research/${slug}-a` },
        { text: `Cutting scope early reduces time-to-publish for ${kw}.`, sourceUrl: `https://example.test/research/${slug}-b` },
      ],
    };
  }
}

/**
 * Deterministic sandbox publisher — the production default. Never touches a network: it derives a stable fake URL
 * from the run id + title and ignores the credential (the sandbox needs none). This is what guarantees enabling
 * the module cannot actually publish.
 */
export class FakePublishProvider implements PublishProvider {
  async publish(input: PublishInput): Promise<PublishResult> {
    const slug = stableHex([input.runId, input.title]);
    return { status: "ok", url: `https://sandbox.test/posts/${slug}` };
  }
}

/** Deterministic sandbox indexer — the production default. Returns a stable fake receipt id; no network IO. */
export class FakeIndexProvider implements IndexProvider {
  async ping(input: IndexPingInput): Promise<IndexPingResult> {
    return { status: "ok", receiptId: `idx_${stableHex([input.runId, input.url])}` };
  }
}

/** Build the default provider registry — all deterministic fakes. The production binding uses this. */
export function createFakeProviders(): PipelineProviders {
  return {
    keyword: new FakeKeywordProvider(),
    brief: new FakeBriefProvider(),
    draft: new FakeDraftProvider(),
    publish: new FakePublishProvider(),
    index: new FakeIndexProvider(),
  };
}

// --- Real scaffolds (no transport wired in this change set) --------------------------------------------------

/** The network seam a real publisher would call. Intentionally NOT implemented/wired here. */
export interface PublishTransport {
  publish(input: PublishInput): Promise<{ url: string }>;
}

/** The network seam a real indexer would call. Intentionally NOT implemented/wired here. */
export interface IndexTransport {
  ping(input: IndexPingInput): Promise<{ receiptId: string }>;
}

/**
 * Real publisher scaffold: a no-op unless BOTH a credential is supplied AND a transport is wired. No credential ⇒
 * `failed` ("no credentials"); credential but no transport ⇒ `failed` ("no transport configured"). No path
 * performs IO in this change set, so nothing live-publishes.
 */
export class RealPublishProvider implements PublishProvider {
  constructor(private readonly transport?: PublishTransport) {}
  async publish(input: PublishInput): Promise<PublishResult> {
    if (!input.credential) return { status: "failed", url: null, error: "no credentials" };
    if (!this.transport) return { status: "failed", url: null, error: "no transport configured" };
    try {
      const { url } = await this.transport.publish(input);
      return { status: "ok", url };
    } catch (err) {
      return { status: "failed", url: null, error: err instanceof Error ? err.message : "publish failed" };
    }
  }
}

/** Real indexer scaffold: same no-op contract as {@link RealPublishProvider}. Never performs IO here. */
export class RealIndexProvider implements IndexProvider {
  constructor(private readonly transport?: IndexTransport) {}
  async ping(input: IndexPingInput): Promise<IndexPingResult> {
    if (!input.credential) return { status: "failed", receiptId: null, error: "no credentials" };
    if (!this.transport) return { status: "failed", receiptId: null, error: "no transport configured" };
    try {
      const { receiptId } = await this.transport.ping(input);
      return { status: "ok", receiptId };
    } catch (err) {
      return { status: "failed", receiptId: null, error: err instanceof Error ? err.message : "index ping failed" };
    }
  }
}
