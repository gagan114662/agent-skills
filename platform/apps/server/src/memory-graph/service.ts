/**
 * The shared memory graph service (issue #585) — the read-before-act / write-after-act API every agent uses
 * so the fleet shares one world model instead of duplicating and contradicting each other. It orchestrates
 * the pure cores ({@link ./normalize}, {@link ./conflict}) over an injected {@link GraphStore}, so it is
 * unit-tested with an in-memory store and a fake clock (no database).
 *
 * The shape enforces the #585 acceptance criteria:
 *   - {@link recall} — BEFORE an agent works a subject, it returns the prior, still-fresh work on that
 *     subject so the agent surfaces the existing result instead of redoing it (AC1);
 *   - {@link checkConflicts} — BEFORE publishing a claim, it flags any active claim it would contradict (AC2);
 *   - {@link record} — AFTER an agent acts, it writes the fact/claim back (deduped), and returns the same
 *     conflict flags so a contradiction is caught at write time too.
 *
 * When the graph is disabled (`MEMORY_GRAPH_ENABLED=0`) the service is inert: recall returns nothing, record
 * persists nothing, and conflict checks return empty — it never blocks a caller.
 */

import { resolveMemoryGraphCaps, type MemoryGraphCaps } from "./caps.js";
import { detectConflicts, type ClaimLike } from "./conflict.js";
import { dedupeKey, subjectKey } from "./normalize.js";
import type { GraphStore } from "./store.js";
import type { Conflict, GraphEdge, GraphNode, NodeKind, Observation } from "./types.js";

export interface MemoryGraphDeps {
  store: GraphStore;
  /** Resolved caps (master switch + recall freshness). Defaults to the env-resolved caps. */
  caps?: MemoryGraphCaps;
  /** Clock seam for observation/supersede timestamps. Defaults to `Date.now`. */
  now?: () => Date;
}

/** What an agent records after acting. `predicate` set ⇒ it is a claim (can contradict); omit it for findings. */
export interface RecordInput {
  kind: NodeKind;
  subject: string;
  value: string;
  predicate?: string | null;
  confidence?: number;
  tags?: string[];
  byAgent?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
}

export interface RecordResult {
  node: GraphNode;
  /** True ⇒ a genuinely new fact; false ⇒ it deduped onto prior work (an agent re-did something). */
  created: boolean;
  /** Contradictions this write introduces against existing active claims (advisory; the write still lands). */
  conflicts: Conflict[];
}

export interface RecallQuery {
  subject: string;
  kind?: NodeKind;
  /** Include superseded/stale nodes too (default false — recall surfaces only fresh, active prior work). */
  includeStale?: boolean;
}

export interface RecallResult {
  /** Prior work on this subject, freshest first. Non-empty ⇒ the agent should reuse it, not redo it. */
  priorWork: GraphNode[];
  hasPriorWork: boolean;
}

export class MemoryGraphService {
  private readonly store: GraphStore;
  private readonly caps: MemoryGraphCaps;
  private readonly now: () => Date;

  constructor(deps: MemoryGraphDeps) {
    this.store = deps.store;
    this.caps = deps.caps ?? resolveMemoryGraphCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the graph is active (the master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /**
   * BEFORE acting: return the prior work on a subject so an agent surfaces it instead of redoing it (AC1).
   * Filters to active nodes within the recall freshness window (unless `includeStale`), freshest first. When
   * disabled, returns no prior work so callers fall through to doing the work themselves.
   */
  async recall(workspaceId: string, query: RecallQuery): Promise<RecallResult> {
    if (!this.caps.enabled) return { priorWork: [], hasPriorWork: false };
    const subject = requireNonEmpty(query.subject, "subject");

    const nodes = await this.store.queryNodes(workspaceId, {
      subjectKey: subjectKey(subject),
      kind: query.kind,
      status: query.includeStale ? "any" : "active",
    });

    const cutoff = this.now().getTime() - this.caps.recallFreshnessMs;
    const priorWork = query.includeStale
      ? nodes
      : nodes.filter((n) => Date.parse(n.updatedAt) >= cutoff);

    return { priorWork, hasPriorWork: priorWork.length > 0 };
  }

  /**
   * BEFORE publishing: flag every active claim the candidate would contradict, WITHOUT writing anything (AC2).
   * A non-empty result means the agent is about to ship a claim that disagrees with the shared graph. Returns
   * `[]` for non-claims (no predicate) and when disabled.
   */
  async checkConflicts(workspaceId: string, candidate: RecordInput): Promise<Conflict[]> {
    if (!this.caps.enabled) return [];
    const predicate = candidate.predicate ?? null;
    if (predicate === null || predicate === "") return [];
    const subject = requireNonEmpty(candidate.subject, "subject");

    const incoming: ClaimLike = {
      id: "$candidate",
      subject,
      predicate,
      value: candidate.value,
      confidence: candidate.confidence ?? 1,
      status: "active",
    };
    const existing = await this.activeClaimsForSubject(workspaceId, subject);
    return detectConflicts(incoming, existing);
  }

  /**
   * AFTER acting: write the fact/claim back into the shared graph (idempotent — a re-assertion dedups onto the
   * existing node and appends an observation). Also runs the conflict check so a contradiction is surfaced at
   * write time. The write ALWAYS lands (conflicts are advisory, not a block); the caller decides what to do
   * with `conflicts` (e.g. route to the #13 approval queue before publishing). When disabled, persists nothing
   * and returns an ephemeral node so callers don't crash.
   */
  async record(workspaceId: string, input: RecordInput): Promise<RecordResult> {
    const subject = requireNonEmpty(input.subject, "subject");
    requireNonEmpty(input.value, "value");
    requireNonEmpty(input.kind, "kind");
    const predicate = normalizePredicate(input.predicate);

    if (!this.caps.enabled) {
      return { node: this.ephemeralNode(workspaceId, input, predicate), created: false, conflicts: [] };
    }

    // Detect conflicts against the pre-write state, so a write never "conflicts with itself".
    const conflicts =
      predicate === null
        ? []
        : detectConflicts(
            {
              id: "$incoming",
              subject,
              predicate,
              value: input.value,
              confidence: input.confidence ?? 1,
              status: "active",
            },
            await this.activeClaimsForSubject(workspaceId, subject),
          );

    const observation: Observation = {
      byAgent: input.byAgent ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      at: this.now().toISOString(),
    };

    const { node, created } = await this.store.upsertNode({
      workspaceId,
      kind: input.kind,
      subject,
      predicate,
      value: input.value,
      dedupeKey: dedupeKey(input.kind, subject, predicate, input.value),
      confidence: input.confidence,
      tags: input.tags,
      observation,
    });

    return { node, created, conflicts };
  }

  /** Load one node by id (workspace-scoped). */
  async get(workspaceId: string, id: string): Promise<GraphNode | null> {
    if (!this.caps.enabled) return null;
    return this.store.getNode(workspaceId, id);
  }

  /**
   * Retire a node from recall + conflict detection (e.g. a corrected claim). Optionally point it at the node
   * that replaced it. Returns the updated node, or `null` if missing in this workspace.
   */
  async supersede(
    workspaceId: string,
    id: string,
    supersededBy: string | null = null,
  ): Promise<GraphNode | null> {
    if (!this.caps.enabled) return null;
    return this.store.supersedeNode(workspaceId, id, supersededBy, this.now().toISOString());
  }

  /** Relate two nodes (the graph's edges, e.g. prospect —reached_via→ channel). Idempotent. */
  async link(
    workspaceId: string,
    fromNodeId: string,
    toNodeId: string,
    relation: string,
  ): Promise<GraphEdge> {
    if (!this.caps.enabled) throw new MemoryGraphError("memory graph is disabled");
    requireNonEmpty(relation, "relation");
    if (fromNodeId === toNodeId) throw new MemoryGraphError("an edge cannot link a node to itself");
    const from = await this.store.getNode(workspaceId, fromNodeId);
    const to = await this.store.getNode(workspaceId, toNodeId);
    if (!from || !to) throw new MemoryGraphError("both endpoints must exist in this workspace");
    const { edge } = await this.store.upsertEdge({
      workspaceId,
      fromNodeId,
      toNodeId,
      relation,
      createdAt: this.now().toISOString(),
    });
    return edge;
  }

  /** The active nodes directly linked to a node (1-hop neighbors) — the relationship view of the graph. */
  async neighbors(workspaceId: string, nodeId: string): Promise<GraphNode[]> {
    if (!this.caps.enabled) return [];
    const edges = await this.store.edgesForNode(workspaceId, nodeId);
    const ids = new Set<string>();
    for (const e of edges) ids.add(e.fromNodeId === nodeId ? e.toNodeId : e.fromNodeId);
    const out: GraphNode[] = [];
    for (const id of ids) {
      const n = await this.store.getNode(workspaceId, id);
      if (n && n.status === "active") out.push(n);
    }
    return out;
  }

  /** All active claim nodes about a subject — the candidate set for conflict detection. */
  private async activeClaimsForSubject(workspaceId: string, subject: string): Promise<ClaimLike[]> {
    const nodes = await this.store.queryNodes(workspaceId, {
      subjectKey: subjectKey(subject),
      status: "active",
    });
    return nodes
      .filter((n) => n.predicate !== null && n.predicate !== "")
      .map((n) => ({
        id: n.id,
        subject: n.subject,
        predicate: n.predicate,
        value: n.value,
        confidence: n.confidence,
        status: n.status,
      }));
  }

  /** A non-persisted node returned when the graph is disabled, so callers get a stable shape. */
  private ephemeralNode(workspaceId: string, input: RecordInput, predicate: string | null): GraphNode {
    const at = this.now().toISOString();
    return {
      id: "$disabled",
      workspaceId,
      kind: input.kind,
      subject: input.subject,
      predicate,
      value: input.value,
      dedupeKey: dedupeKey(input.kind, input.subject, predicate, input.value),
      confidence: input.confidence ?? 1,
      status: "active",
      supersededBy: null,
      tags: input.tags ?? [],
      observations: [],
      createdAt: at,
      updatedAt: at,
    };
  }
}

/** A graph operation rejected for a stated reason (mapped to 400/409 at a route layer). */
export class MemoryGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryGraphError";
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MemoryGraphError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Normalize a predicate: trim, and treat empty/whitespace/undefined as "no predicate" (a finding, not a claim). */
function normalizePredicate(predicate: string | null | undefined): string | null {
  if (predicate === undefined || predicate === null) return null;
  const trimmed = predicate.trim();
  return trimmed === "" ? null : trimmed;
}
