/**
 * Auto-capture orchestration (issue #15, ADR-0015).
 *
 * `planCapture` is the pure core — extraction in, a concrete upsert plan out (dedup keys
 * computed, invalid edges dropped). `captureFromSource` runs the chosen extractor and applies
 * the plan against the workspace-scoped repo with idempotent upserts.
 */
import { DeterministicExtractor, type Extraction, type MemoryExtractor } from "./extract.js";
import { dedupeKey } from "./dedupe.js";
import { upsertMemory, upsertEdge } from "../db/repositories/memory.js";

/** A node ready to upsert: dedup key resolved. */
export interface PlannedNode {
  type: string;
  text: string;
  entity: string | null;
  dedupeKey: string;
}

export interface PlannedEdge {
  fromIndex: number;
  toIndex: number;
  relation: string;
}

export interface CapturePlan {
  nodes: PlannedNode[];
  edges: PlannedEdge[];
}

/**
 * Pure: turn an extraction into an upsert plan. Computes each node's dedup key and keeps only
 * edges whose endpoints are distinct, in-range node indices. No DB or I/O — unit-testable with
 * any `MemoryExtractor` stub.
 */
export function planCapture(extraction: Extraction): CapturePlan {
  const nodes: PlannedNode[] = extraction.memories.map((m) => ({
    type: m.type,
    text: m.text,
    entity: m.entity ?? null,
    dedupeKey: dedupeKey(m.type, m.text, m.entity ?? null),
  }));
  const edges = extraction.edges.filter(
    (e) =>
      Number.isInteger(e.fromIndex) &&
      Number.isInteger(e.toIndex) &&
      e.fromIndex >= 0 &&
      e.fromIndex < nodes.length &&
      e.toIndex >= 0 &&
      e.toIndex < nodes.length &&
      e.fromIndex !== e.toIndex,
  );
  return { nodes, edges };
}

export interface CaptureInput {
  workspaceId: string;
  text: string;
  sourceType?: string | null;
  sourceId?: string | null;
  createdByMemberId?: string | null;
}

export interface CaptureResult {
  memories: { id: string; type: string; created: boolean }[];
  edges: { id: string; relation: string; created: boolean }[];
}

/**
 * Capture typed nodes + edges from a piece of workspace activity. The extractor is pluggable
 * and defaults to the deterministic fallback. Upserts are idempotent (dedup), so re-capturing
 * the same source collapses to the same nodes.
 */
export async function captureFromSource(
  input: CaptureInput,
  extractor: MemoryExtractor = new DeterministicExtractor(),
): Promise<CaptureResult> {
  const plan = planCapture(await extractor.extract({ text: input.text }));

  const ids: string[] = [];
  const memories: CaptureResult["memories"] = [];
  for (const n of plan.nodes) {
    const r = await upsertMemory({
      workspaceId: input.workspaceId,
      type: n.type,
      content: { text: n.text },
      entity: n.entity,
      dedupeKey: n.dedupeKey,
      sourceType: input.sourceType ?? "event",
      sourceId: input.sourceId ?? null,
      createdByMemberId: input.createdByMemberId ?? null,
    });
    ids.push(r.id);
    memories.push({ id: r.id, type: n.type, created: r.created });
  }

  const edges: CaptureResult["edges"] = [];
  for (const e of plan.edges) {
    const r = await upsertEdge({
      workspaceId: input.workspaceId,
      fromMemoryId: ids[e.fromIndex]!,
      toMemoryId: ids[e.toIndex]!,
      relation: e.relation,
      createdByMemberId: input.createdByMemberId ?? null,
    });
    edges.push({ id: r.id, relation: e.relation, created: r.created });
  }

  return { memories, edges };
}
