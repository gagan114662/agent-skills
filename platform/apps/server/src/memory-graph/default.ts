/**
 * Production binding for the shared memory graph (issue #585). The store here is deliberately
 * **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #585 change set
 * inside `memory-graph/` (plus its tests) so it never collides with a sibling branch's migration numbering or
 * schema barrel — the explicit parallel-merge-safety goal of the recent self-contained modules (#670/#674/…).
 * The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * Idempotent dedup uses `INSERT … ON CONFLICT (workspace_id, dedupe_key) DO UPDATE`, which is atomic at the
 * row level — so a burst of concurrent identical writes from different agents collapses to one node (each
 * caller's observation appended) instead of racing into duplicates. The `xmax = 0` flag in RETURNING tells
 * insert (new fact) from update (deduped onto prior work).
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { resolveMemoryGraphCaps } from "./caps.js";
import { MemoryGraphService } from "./service.js";
import type {
  GraphStore,
  NodeQuery,
  UpsertEdgeInput,
  UpsertEdgeResult,
  UpsertNodeInput,
  UpsertNodeResult,
} from "./store.js";
import type { GraphEdge, GraphNode, Observation } from "./types.js";

const NODE_TABLE = "memory_graph_nodes";
const EDGE_TABLE = "memory_graph_edges";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${NODE_TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  kind          text NOT NULL,
  subject       text NOT NULL,
  subject_key   text NOT NULL,
  predicate     text,
  value         text NOT NULL,
  dedupe_key    text NOT NULL,
  confidence    double precision NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'active',
  superseded_by text,
  tags          jsonb NOT NULL DEFAULT '[]'::jsonb,
  observations  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ${NODE_TABLE}_ws_subject_idx ON ${NODE_TABLE} (workspace_id, subject_key, status);
CREATE TABLE IF NOT EXISTS ${EDGE_TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  from_node_id  text NOT NULL,
  to_node_id    text NOT NULL,
  relation      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_node_id, to_node_id, relation)
);
CREATE INDEX IF NOT EXISTS ${EDGE_TABLE}_ws_node_idx ON ${EDGE_TABLE} (workspace_id, from_node_id, to_node_id);
`;

interface NodeRow {
  id: string;
  workspace_id: string;
  kind: string;
  subject: string;
  predicate: string | null;
  value: string;
  dedupe_key: string;
  confidence: number;
  status: GraphNode["status"];
  superseded_by: string | null;
  tags: string[];
  observations: Observation[];
  created_at: Date;
  updated_at: Date;
}

interface EdgeRow {
  id: string;
  workspace_id: string;
  from_node_id: string;
  to_node_id: string;
  relation: string;
  created_at: Date;
}

function iso(d: Date): string {
  return d.toISOString();
}

function toNode(r: NodeRow): GraphNode {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    subject: r.subject,
    predicate: r.predicate,
    value: r.value,
    dedupeKey: r.dedupe_key,
    confidence: Number(r.confidence),
    status: r.status,
    supersededBy: r.superseded_by,
    tags: Array.isArray(r.tags) ? r.tags : [],
    observations: Array.isArray(r.observations) ? r.observations : [],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toEdge(r: EdgeRow): GraphEdge {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    fromNodeId: r.from_node_id,
    toNodeId: r.to_node_id,
    relation: r.relation,
    createdAt: iso(r.created_at),
  };
}

/** Postgres-backed {@link GraphStore} that owns (and lazily creates) its own tables. */
export class PgGraphStore implements GraphStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async upsertNode(input: UpsertNodeInput): Promise<UpsertNodeResult> {
    await this.ensureSchema();
    const obs = JSON.stringify([input.observation]);
    const tags = JSON.stringify(input.tags ?? []);
    // ON CONFLICT on (workspace_id, dedupe_key): append the observation, keep the strongest confidence, union
    // the tags, bump updated_at. `xmax = 0` ⇒ this row was inserted (a new fact), not updated (a dedup).
    const res = await getPool().query<NodeRow & { created: boolean }>(
      `INSERT INTO ${NODE_TABLE}
         (id, workspace_id, kind, subject, subject_key, predicate, value, dedupe_key, confidence, tags, observations, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
       ON CONFLICT (workspace_id, dedupe_key) DO UPDATE SET
         observations = ${NODE_TABLE}.observations || EXCLUDED.observations,
         confidence   = GREATEST(${NODE_TABLE}.confidence, EXCLUDED.confidence),
         tags         = (
           SELECT COALESCE(jsonb_agg(DISTINCT t), '[]'::jsonb)
           FROM jsonb_array_elements(${NODE_TABLE}.tags || EXCLUDED.tags) AS t
         ),
         updated_at   = EXCLUDED.updated_at
       RETURNING *, (xmax = 0) AS created`,
      [
        newId(),
        input.workspaceId,
        input.kind,
        input.subject,
        subjectKeyOf(input.subject),
        input.predicate,
        input.value,
        input.dedupeKey,
        input.confidence ?? 1,
        tags,
        obs,
        input.observation.at,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("memory-graph: upsert produced no row");
    return { node: toNode(row), created: row.created };
  }

  async getNode(workspaceId: string, id: string): Promise<GraphNode | null> {
    await this.ensureSchema();
    const res = await getPool().query<NodeRow>(
      `SELECT * FROM ${NODE_TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toNode(res.rows[0]) : null;
  }

  async queryNodes(workspaceId: string, query: NodeQuery): Promise<GraphNode[]> {
    await this.ensureSchema();
    const where: string[] = ["workspace_id = $1"];
    const params: unknown[] = [workspaceId];
    const status = query.status ?? "active";
    if (status !== "any") {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (query.kind !== undefined) {
      params.push(query.kind);
      where.push(`kind = $${params.length}`);
    }
    if (query.subjectKey !== undefined) {
      params.push(query.subjectKey);
      where.push(`subject_key = $${params.length}`);
    }
    const res = await getPool().query<NodeRow>(
      `SELECT * FROM ${NODE_TABLE} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC`,
      params,
    );
    return res.rows.map(toNode);
  }

  async supersedeNode(
    workspaceId: string,
    id: string,
    supersededBy: string | null,
    at: string,
  ): Promise<GraphNode | null> {
    await this.ensureSchema();
    const res = await getPool().query<NodeRow>(
      `UPDATE ${NODE_TABLE}
         SET status = 'superseded', superseded_by = $3, updated_at = $4
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [id, workspaceId, supersededBy, at],
    );
    return res.rows[0] ? toNode(res.rows[0]) : null;
  }

  async upsertEdge(input: UpsertEdgeInput): Promise<UpsertEdgeResult> {
    await this.ensureSchema();
    const res = await getPool().query<EdgeRow & { created: boolean }>(
      `INSERT INTO ${EDGE_TABLE} (id, workspace_id, from_node_id, to_node_id, relation, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, from_node_id, to_node_id, relation) DO UPDATE SET relation = EXCLUDED.relation
       RETURNING *, (xmax = 0) AS created`,
      [newId(), input.workspaceId, input.fromNodeId, input.toNodeId, input.relation, input.createdAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error("memory-graph: edge upsert produced no row");
    return { edge: toEdge(row), created: row.created };
  }

  async edgesForNode(workspaceId: string, nodeId: string): Promise<GraphEdge[]> {
    await this.ensureSchema();
    const res = await getPool().query<EdgeRow>(
      `SELECT * FROM ${EDGE_TABLE}
       WHERE workspace_id = $1 AND (from_node_id = $2 OR to_node_id = $2)
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, nodeId],
    );
    return res.rows.map(toEdge);
  }
}

/** Same subject normalization the pure core uses — kept inline so the store row carries a queryable key column. */
function subjectKeyOf(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build the production memory-graph service over the self-managed Postgres store + env-resolved caps. */
export function createDefaultMemoryGraphService(): MemoryGraphService {
  return new MemoryGraphService({ store: new PgGraphStore(), caps: resolveMemoryGraphCaps() });
}
