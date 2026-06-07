/**
 * Auto-capture extraction (issue #15, ADR-0015).
 *
 * `MemoryExtractor` is the pluggable port: text in, typed nodes + edges out. The production
 * default is the hermetic, network-free `DeterministicExtractor`. `LlmExtractor` implements the
 * same port over an injected `LlmClient`, so an LLM can be wired in without a key or network in
 * tests/CI. Routes never see this layer — the capture service chooses the extractor.
 */

/** Canonical node types the deterministic extractor emits. The schema allows others (extensible). */
export const MEMORY_TYPES = ["decision", "fact", "preference", "artifact"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** A typed node proposed from a piece of text. */
export interface CapturedMemory {
  type: string;
  text: string;
  entity?: string | null;
}

/** A typed edge between two proposed nodes, addressed by their index in `memories`. */
export interface CapturedEdge {
  fromIndex: number;
  toIndex: number;
  relation: string;
}

export interface Extraction {
  memories: CapturedMemory[];
  edges: CapturedEdge[];
}

export interface MemoryExtractor {
  extract(input: { text: string }): Promise<Extraction>;
}

const DECISION = /\b(decided|decision|we will|we'll|let's|going with|chose|choose)\b/i;
const PREFERENCE = /\b(prefer|i like|i'd like|please always|from now on|always use|never use)\b/i;
const URL = /https?:\/\/\S+/i;
const FILE_PATH = /\b[\w./-]+\.(ts|js|tsx|md|png|jpg|sql|json|ya?ml|sh|pdf|mp4|csv)\b/i;
const TAG = /#(\w+)/;

/**
 * Split a blob into statements: one per line, or per sentence. A sentence boundary is `.!?`
 * followed by whitespace — so dots inside URLs, file paths, and numbers (no following space)
 * never split a statement. Trailing terminators are trimmed.
 */
function statements(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, "").trim())
    .filter((s) => s.length > 0);
}

/** Rule-based classification into the canonical types. Order is deliberate; first match wins. */
function classify(s: string): MemoryType {
  if (DECISION.test(s)) return "decision";
  if (PREFERENCE.test(s)) return "preference";
  if (URL.test(s) || FILE_PATH.test(s) || /\bartifact\b/i.test(s)) return "artifact";
  return "fact";
}

/**
 * Deterministic, dependency-free extractor (the default fallback). Splits the source into
 * statements, classifies each, lifts an `entity` from a leading `#tag`, and links every
 * non-anchor statement back to the first with a `relates_to` edge — so a multi-statement
 * source yields nodes AND edges.
 */
export class DeterministicExtractor implements MemoryExtractor {
  async extract(input: { text: string }): Promise<Extraction> {
    const memories: CapturedMemory[] = statements(input.text).map((s) => {
      const tag = TAG.exec(s);
      return { type: classify(s), text: s, entity: tag ? tag[1]! : null };
    });
    const edges: CapturedEdge[] = memories
      .slice(1)
      .map((_, i) => ({ fromIndex: i + 1, toIndex: 0, relation: "relates_to" }));
    return { memories, edges };
  }
}

/** A minimal completion port — the only thing `LlmExtractor` needs from any LLM provider. */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

/** Prompt the model to return strict JSON matching `Extraction`. */
function buildPrompt(text: string): string {
  return [
    "Extract durable memory from the text below as JSON of the shape",
    '{"memories":[{"type","text","entity"}],"edges":[{"fromIndex","toIndex","relation"}]}.',
    `Types are one of: ${MEMORY_TYPES.join(", ")}. Respond with JSON only.`,
    "---",
    text,
  ].join("\n");
}

/** Coerce arbitrary model output into a safe `Extraction`; never throws. */
function parseExtraction(raw: string): Extraction {
  try {
    const parsed = JSON.parse(raw) as Partial<Extraction>;
    const memories = Array.isArray(parsed.memories)
      ? parsed.memories.filter((m) => m && typeof m.type === "string" && typeof m.text === "string")
      : [];
    const edges = Array.isArray(parsed.edges)
      ? parsed.edges.filter(
          (e) =>
            e &&
            Number.isInteger(e.fromIndex) &&
            Number.isInteger(e.toIndex) &&
            typeof e.relation === "string",
        )
      : [];
    return { memories, edges };
  } catch {
    return { memories: [], edges: [] };
  }
}

/** LLM-assisted extractor over an injected client. Inert unless a client is provided. */
export class LlmExtractor implements MemoryExtractor {
  constructor(private readonly client: LlmClient) {}

  async extract(input: { text: string }): Promise<Extraction> {
    const raw = await this.client.complete(buildPrompt(input.text));
    return parseExtraction(raw);
  }
}
