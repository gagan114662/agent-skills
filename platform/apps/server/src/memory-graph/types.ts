/**
 * Domain types for the shared agent memory graph (issue #585).
 *
 * The graph is a per-workspace, shared world model that every agent reads BEFORE acting and writes
 * to AFTER acting, so two agents don't redo the same research and one doesn't publish a claim another
 * already contradicted. A {@link GraphNode} is one shared fact/decision/entity; a {@link GraphEdge} is a
 * typed relationship between two of them. Everything is workspace-scoped (the #3 IDOR boundary).
 *
 * The types live here, free of IO, so the pure cores ({@link ./normalize}, {@link ./conflict}) and the
 * service can be unit-tested without a database.
 */

/**
 * The kinds of thing the graph remembers. The issue calls out prospects, channels, experiments, claims,
 * and assets; `research` and `note` cover the generic "an agent did some work and recorded a finding" case.
 * Any string is accepted by the store — these are the well-known kinds callers should prefer.
 */
export const NODE_KINDS = [
  "prospect",
  "channel",
  "experiment",
  "claim",
  "asset",
  "research",
  "note",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number] | (string & {});

export type NodeStatus = "active" | "superseded";

/**
 * A single provenance record: which agent/source asserted this node, and when. Concurrent identical
 * writes (the dedup case) append an observation rather than create a duplicate node, so the graph keeps a
 * full record of *who* already covered a piece of work — the signal AC1 uses to say "this was already done".
 */
export interface Observation {
  /** The agent (or role) that recorded this. Free-form; `null` if unattributed. */
  byAgent: string | null;
  /** Provenance of the assertion (e.g. "research", "scrape", "email"). */
  sourceType: string | null;
  /** An opaque id of the originating activity (run id, message id, …) for back-tracing. */
  sourceId: string | null;
  /** ISO timestamp the observation was recorded. */
  at: string;
}

/**
 * One node in the shared graph: a typed, deduped statement about a `subject`.
 *
 *   - `subject` is the normalized identity of *what the node is about* (a prospect name, a channel, an
 *     experiment id, a research keyword). Recall groups by it, so an agent about to work on a subject can
 *     find prior work on it.
 *   - `predicate` is set only for **claims** — the attribute being asserted about the subject (e.g.
 *     "pricing_model", "primary_channel"). Two active claims with the same (subject, predicate) but a
 *     different `value` are a contradiction (see {@link ./conflict}). For non-claims it is `null`.
 *   - `value` is the asserted value (a claim's value, or a finding's text).
 */
export interface GraphNode {
  id: string;
  workspaceId: string;
  kind: NodeKind;
  subject: string;
  predicate: string | null;
  value: string;
  /** sha256 over (kind, subject, predicate, normalized value): the idempotent-merge key. */
  dedupeKey: string;
  /** Asserter confidence in [0,1]; defaults to 1. Used to order conflicting claims. */
  confidence: number;
  status: NodeStatus;
  /** When superseded, the id of the node that replaced it (or `null` if just retired). */
  supersededBy: string | null;
  tags: string[];
  observations: Observation[];
  createdAt: string;
  updatedAt: string;
}

export type EdgeRelation = string;

/** A typed relationship between two nodes in the same workspace (the graph's edges). */
export interface GraphEdge {
  id: string;
  workspaceId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: EdgeRelation;
  createdAt: string;
}

/**
 * A detected contradiction: an `incoming` claim disagrees with an already-`existing` active claim about the
 * same (subject, predicate). Advisory by construction — surfacing a conflict never blocks a write; it gives
 * the caller (and a pre-publish gate) what it needs to flag the disagreement before it ships.
 */
export interface Conflict {
  subject: string;
  predicate: string;
  existingNodeId: string;
  existingValue: string;
  existingConfidence: number;
  incomingValue: string;
  incomingConfidence: number;
}
