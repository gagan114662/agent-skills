/**
 * Production binding for competitive-intelligence monitoring (issue #619). The store here is deliberately
 * **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #619
 * change set inside `competitive-intel/` so it never collides with a sibling branch's migration numbering or
 * schema barrel — the explicit parallel-merge-safety goal (the proven #670/#674/#587 pattern). The DDL is
 * additive and idempotent, so it composes safely with the migration runner.
 *
 * `competitor_snapshots` holds the point-in-time observations the diff runs against; `competitor_digests`
 * holds the generated weekly digests. Every workspace-scoped query carries `workspace_id` (#3 IDOR). The
 * snapshot/digest payloads are stored as jsonb so each row is self-contained.
 *
 * This module is imported DIRECTLY by app wiring (when it is eventually wired) and is intentionally NOT
 * re-exported from `index.ts`, so pure consumers and unit tests never load the Postgres driver.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { CompetitiveIntelService } from "./service.js";
import type {
  CompetitiveIntelStore,
  DigestRecord,
  SaveDigestInput,
  SaveSnapshotInput,
  SnapshotRecord,
} from "./store.js";
import type { CompetitorDigest, CompetitorSnapshot } from "./types.js";

const SNAPSHOTS = "competitor_snapshots";
const DIGESTS = "competitor_digests";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${SNAPSHOTS} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  competitor_id text NOT NULL,
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${SNAPSHOTS}_ws_competitor_idx
  ON ${SNAPSHOTS} (workspace_id, competitor_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS ${DIGESTS} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  digest                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by_member_id text,
  generated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${DIGESTS}_ws_generated_idx
  ON ${DIGESTS} (workspace_id, generated_at DESC);
`;

interface SnapshotRow {
  id: string;
  workspace_id: string;
  competitor_id: string;
  snapshot: CompetitorSnapshot | string;
  captured_at: Date;
}

interface DigestRow {
  id: string;
  workspace_id: string;
  digest: CompetitorDigest | string;
  requested_by_member_id: string | null;
  generated_at: Date;
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const EMPTY_SNAPSHOT = (): CompetitorSnapshot => ({
  competitor: { id: "", name: "" },
  pricing: [],
  messaging: { tagline: "", valueProps: [], sourceUrl: null },
  launches: [],
});

function toSnapshotRecord(r: SnapshotRow): SnapshotRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    competitorId: r.competitor_id,
    snapshot: parseJson(r.snapshot, EMPTY_SNAPSHOT()),
    capturedAt: r.captured_at,
  };
}

function toDigestRecord(r: DigestRow): DigestRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    digest: parseJson(r.digest, {
      workspaceId: r.workspace_id,
      generatedAt: r.generated_at.toISOString(),
      competitorIds: [],
      counts: { pricing: 0, messaging: 0, launch: 0, total: 0 },
      changes: [],
      highlights: [],
      sources: [],
      servedBy: "fake-disabled",
    }),
    requestedByMemberId: r.requested_by_member_id,
    generatedAt: r.generated_at,
  };
}

/** Postgres-backed {@link CompetitiveIntelStore} that owns (and lazily creates) its own two tables. */
export class PgCompetitiveIntelStore implements CompetitiveIntelStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async latestSnapshot(workspaceId: string, competitorId: string): Promise<SnapshotRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<SnapshotRow>(
      `SELECT * FROM ${SNAPSHOTS}
       WHERE workspace_id = $1 AND competitor_id = $2
       ORDER BY captured_at DESC, id DESC LIMIT 1`,
      [workspaceId, competitorId],
    );
    return res.rows[0] ? toSnapshotRecord(res.rows[0]) : null;
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SnapshotRecord> {
    await this.ensureSchema();
    const res = await getPool().query<SnapshotRow>(
      `INSERT INTO ${SNAPSHOTS} (id, workspace_id, competitor_id, snapshot, captured_at)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
      [newId(), input.workspaceId, input.competitorId, JSON.stringify(input.snapshot), input.capturedAt],
    );
    const row = res.rows[0];
    if (!row) throw new Error("competitive-intel: snapshot INSERT ... RETURNING produced no row");
    return toSnapshotRecord(row);
  }

  async saveDigest(input: SaveDigestInput): Promise<DigestRecord> {
    await this.ensureSchema();
    const res = await getPool().query<DigestRow>(
      `INSERT INTO ${DIGESTS} (id, workspace_id, digest, requested_by_member_id, generated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        JSON.stringify(input.digest),
        input.requestedByMemberId,
        input.generatedAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("competitive-intel: digest INSERT ... RETURNING produced no row");
    return toDigestRecord(row);
  }

  async getDigest(workspaceId: string, id: string): Promise<DigestRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<DigestRow>(
      `SELECT * FROM ${DIGESTS} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toDigestRecord(res.rows[0]) : null;
  }

  async listDigests(workspaceId: string, limit?: number): Promise<DigestRecord[]> {
    await this.ensureSchema();
    const res =
      limit !== undefined
        ? await getPool().query<DigestRow>(
            `SELECT * FROM ${DIGESTS} WHERE workspace_id = $1 ORDER BY generated_at DESC, id DESC LIMIT $2`,
            [workspaceId, limit],
          )
        : await getPool().query<DigestRow>(
            `SELECT * FROM ${DIGESTS} WHERE workspace_id = $1 ORDER BY generated_at DESC, id DESC`,
            [workspaceId],
          );
    return res.rows.map(toDigestRecord);
  }
}

/**
 * Build the production competitive-intelligence service over the self-managed Postgres store. The default
 * source is the offline fake — a real competitor source is a deliberate, owner-gated follow-up injected here
 * once the module is enabled (`COMPETITIVE_INTEL_ENABLED=1`).
 */
export function createDefaultCompetitiveIntelService(): CompetitiveIntelService {
  return new CompetitiveIntelService({ store: new PgCompetitiveIntelStore() });
}
