/**
 * Production binding for the central campaign brief (#588). The store here is deliberately **self-managed**:
 * it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an intentional deviation from
 * the repo's usual migration convention, taken to keep the entire #588 change set inside `campaign-brief/` +
 * a couple of handlers in the already-registered `routes/marketing.ts` so it never collides with a sibling
 * branch's migration numbering or schema barrel — the same parallel-merge-safety pattern as #670/#674/#584.
 * The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * The brief is stored as a single JSONB blob per workspace plus a revision counter and the last-editor
 * audit. JSONB keeps the brief's shape (lists, new fields) free to evolve without a migration.
 */

import { getPool } from "../db/index.js";
import { EMPTY_BRIEF, type CampaignBrief } from "./brief.js";
import { CampaignBriefService } from "./service.js";
import { emptyRecord, type BriefRecord, type BriefStore, type SaveBriefInput } from "./store.js";

const TABLE = "campaign_brief";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  workspace_id          text PRIMARY KEY,
  brief                 jsonb NOT NULL,
  revision              integer NOT NULL DEFAULT 0,
  updated_by_member_id  text,
  updated_at            timestamptz
);
`;

interface BriefRow {
  workspace_id: string;
  brief: unknown;
  revision: string | number;
  updated_by_member_id: string | null;
  updated_at: Date | null;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));

/**
 * Coerce a stored JSONB blob back into a {@link CampaignBrief}, tolerating an older/partial shape by filling
 * from {@link EMPTY_BRIEF}. The values were sanitized on the way in (the only writer is `normalizeBrief`), so
 * this is a shape guard, not a re-sanitization.
 */
function toBrief(raw: unknown): CampaignBrief {
  const o = (raw ?? {}) as Partial<CampaignBrief>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    icp: str(o.icp),
    positioning: str(o.positioning),
    voice: str(o.voice),
    goals: list(o.goals),
    constraints: list(o.constraints),
    brandClaims: list(o.brandClaims),
  };
}

function toRecord(row: BriefRow): BriefRecord {
  return {
    workspaceId: row.workspace_id,
    brief: toBrief(row.brief),
    revision: n(row.revision),
    updatedByMemberId: row.updated_by_member_id,
    updatedAt: row.updated_at,
  };
}

/** Postgres-backed {@link BriefStore} that owns (and lazily creates) its own table. */
export class PgBriefStore implements BriefStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async get(workspaceId: string): Promise<BriefRecord> {
    await this.ensureSchema();
    const res = await getPool().query<BriefRow>(
      `SELECT workspace_id, brief, revision, updated_by_member_id, updated_at FROM ${TABLE} WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : emptyRecord(workspaceId);
  }

  async save(input: SaveBriefInput): Promise<BriefRecord> {
    await this.ensureSchema();
    const res = await getPool().query<BriefRow>(
      `INSERT INTO ${TABLE} (workspace_id, brief, revision, updated_by_member_id, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE SET
         brief = EXCLUDED.brief,
         revision = EXCLUDED.revision,
         updated_by_member_id = EXCLUDED.updated_by_member_id,
         updated_at = EXCLUDED.updated_at
       RETURNING workspace_id, brief, revision, updated_by_member_id, updated_at`,
      [
        input.workspaceId,
        JSON.stringify(input.brief),
        input.revision,
        input.updatedByMemberId,
        input.updatedAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("campaign-brief: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }
}

let cached: CampaignBriefService | undefined;

/** Build (once) the production campaign brief service over the self-managed Postgres store. */
export function createDefaultCampaignBriefService(): CampaignBriefService {
  if (!cached) cached = new CampaignBriefService({ store: new PgBriefStore() });
  return cached;
}

export { EMPTY_BRIEF };
