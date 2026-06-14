import {
  VENTURE_MEMORY_KINDS,
  isVentureMemoryKind,
  type VentureMemoryEntry,
  type VentureMemoryKind,
} from "./types.js";
import type { OkrDrift } from "./okr.js";

/**
 * Venture memory conventions + brief composition (#197, ADR-0197). **Pure** — no DB. Venture memory
 * reuses the #15 `memories` table: every venture memory is a row with `type = venture_memory`, `entity =
 * venture:<ideaId>` (the label-match retrieval key), and a `kind` in the JSON `content`. This module owns
 * the encoding (entity key, dedupe key, content shape), the decoding (`toVentureEntry`), and the pure
 * `composeVentureBrief` that renders the retrieved memories + OKR drift into the text injected into a new
 * venture session — the cure for "sessions are goldfish".
 */

/** The fixed `memories.type` for a venture memory (the kind is the sub-taxonomy in `content`). */
export const VENTURE_MEMORY_TYPE = "venture_memory";

/** The #15 `entity` retrieval key for a venture's memories. */
export function ventureEntity(ideaId: string): string {
  return `venture:${ideaId}`;
}

/** Parse the ideaId back out of a `venture:<ideaId>` entity, or null when it isn't one. */
export function ideaIdFromEntity(entity: string | null): string | null {
  if (!entity || !entity.startsWith("venture:")) return null;
  const id = entity.slice("venture:".length);
  return id.length > 0 ? id : null;
}

/** A stable lowercase slug of a statement (for the dedupe key). Bounded length, ASCII-safe. */
export function slugify(text: string, max = 64): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

/**
 * The idempotent dedupe key for a venture memory — `(workspace, dedupe_key)` is the #15 upsert target,
 * so re-recording the same (venture, kind, statement) merges instead of duplicating.
 */
export function ventureMemoryDedupeKey(
  ideaId: string,
  kind: VentureMemoryKind,
  text: string,
): string {
  return `vm:${ideaId}:${kind}:${slugify(text)}`;
}

/** The JSON `content` for a venture memory row (always carries `text`; `kind` is required). */
export function ventureMemoryContent(input: {
  kind: VentureMemoryKind;
  text: string;
  why?: string | null;
  sourceRef?: string | null;
}): { text: string } & Record<string, unknown> {
  return {
    text: input.text,
    kind: input.kind,
    ...(input.why != null ? { why: input.why } : {}),
    ...(input.sourceRef != null ? { sourceRef: input.sourceRef } : {}),
  };
}

/** A #15 memory node reduced to what {@link toVentureEntry} needs (the IO layer supplies it). */
export interface RawVentureNode {
  id: string;
  content: { text: string } & Record<string, unknown>;
  entity: string | null;
  createdAtMs: number;
  /** True when superseded (#16) — `supersededByMemoryId !== null`. */
  stale: boolean;
}

/**
 * Decode a #15 node into a {@link VentureMemoryEntry}, or null when it is not a well-formed venture
 * memory (no venture entity, or an unknown `kind`). Pure — the IO layer maps DB rows to `RawVentureNode`.
 */
export function toVentureEntry(node: RawVentureNode): VentureMemoryEntry | null {
  const ideaId = ideaIdFromEntity(node.entity);
  if (!ideaId) return null;
  const kind = node.content.kind;
  if (!isVentureMemoryKind(kind)) return null;
  const why = node.content.why;
  const sourceRef = node.content.sourceRef;
  return {
    id: node.id,
    ideaId,
    kind,
    text: node.content.text,
    why: typeof why === "string" ? why : null,
    sourceRef: typeof sourceRef === "string" ? sourceRef : null,
    createdAtMs: node.createdAtMs,
    stale: node.stale,
  };
}

/** Human label for each kind, used in the brief headers. */
const KIND_LABEL: Record<VentureMemoryKind, string> = {
  decision: "Decisions (and why)",
  worked: "What worked",
  failed: "What failed",
  customer_voice: "Customer voice",
  brand_fact: "Brand facts",
};

export interface VentureBriefInput {
  ideaId: string;
  /** The venture's memories, already filtered to this venture (stale ones excluded by the caller). */
  memories: VentureMemoryEntry[];
  /** The venture's OKRs with computed drift (surfaced in every brief with drift flags). */
  okrDrift: OkrDrift[];
  /** Max memories rendered per kind (bounds the brief). */
  maxPerKind: number;
}

/**
 * Compose the venture brief injected into a new session's context (the AC1 "retrieved into every new
 * session" surface). Deterministic, grouped by kind, OKRs first with their drift flags. Returns an empty
 * string when there is nothing to say (a brand-new venture) so the caller can skip injection cleanly.
 */
export function composeVentureBrief(input: VentureBriefInput): string {
  const sections: string[] = [];

  if (input.okrDrift.length > 0) {
    const lines = input.okrDrift.map((o) => {
      const flag = o.drifting ? " ⚠ DRIFT" : "";
      const krs = o.keyResults
        .map((k) => `${k.metric} ${k.current}/${k.target} [${k.status}]`)
        .join("; ");
      return `- ${o.objective}${flag}: ${krs}`;
    });
    sections.push(`## OKRs\n${lines.join("\n")}`);
  }

  for (const kind of VENTURE_MEMORY_KINDS) {
    const ofKind = input.memories.filter((m) => m.kind === kind).slice(0, input.maxPerKind);
    if (ofKind.length === 0) continue;
    const lines = ofKind.map((m) => {
      const why = m.kind === "decision" && m.why ? ` — because ${m.why}` : "";
      return `- ${m.text}${why}`;
    });
    sections.push(`## ${KIND_LABEL[kind]}\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";
  return [`# Venture memory (${input.ideaId})`, ...sections].join("\n\n");
}
