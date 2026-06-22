/**
 * Persistence seam for competitive-intelligence monitoring (issue #619). Narrow interface the service
 * consumes: read a competitor's most recent snapshot (so the next observation can be diffed against it),
 * append a fresh snapshot, and append/read the generated digests. The production binding is the self-managed
 * Postgres store in `default.ts`; unit tests inject {@link InMemoryCompetitiveIntelStore}, so the service and
 * the diff core are tested with no database (the proven pure-core + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a
 * caller can only ever read or mutate its own tenant's data — the #3 IDOR boundary.
 */

import type { CompetitorDigest, CompetitorSnapshot } from "./types.js";

/** A stored point-in-time snapshot of one competitor. */
export interface SnapshotRecord {
  id: string;
  workspaceId: string;
  competitorId: string;
  snapshot: CompetitorSnapshot;
  capturedAt: Date;
}

export interface SaveSnapshotInput {
  workspaceId: string;
  competitorId: string;
  snapshot: CompetitorSnapshot;
  capturedAt: Date;
}

/** A stored, generated digest. */
export interface DigestRecord {
  id: string;
  workspaceId: string;
  digest: CompetitorDigest;
  requestedByMemberId: string | null;
  generatedAt: Date;
}

export interface SaveDigestInput {
  workspaceId: string;
  digest: CompetitorDigest;
  requestedByMemberId: string | null;
  generatedAt: Date;
}

export interface CompetitiveIntelStore {
  /** The most recent snapshot stored for a competitor (the baseline for the next diff), or null if none. */
  latestSnapshot(workspaceId: string, competitorId: string): Promise<SnapshotRecord | null>;
  /** Append a freshly observed snapshot. */
  saveSnapshot(input: SaveSnapshotInput): Promise<SnapshotRecord>;
  /** Append a generated digest. */
  saveDigest(input: SaveDigestInput): Promise<DigestRecord>;
  /** Load one digest within a workspace (#3 IDOR scoping). */
  getDigest(workspaceId: string, id: string): Promise<DigestRecord | null>;
  /** A workspace's digests, newest first, optionally limited. */
  listDigests(workspaceId: string, limit?: number): Promise<DigestRecord[]>;
}

/**
 * In-memory {@link CompetitiveIntelStore} for unit tests. Deterministic: ids are monotonic counters and the
 * clock is injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryCompetitiveIntelStore implements CompetitiveIntelStore {
  private readonly snapshots: SnapshotRecord[] = [];
  private readonly digests: DigestRecord[] = [];
  private snapSeq = 0;
  private digestSeq = 0;

  async latestSnapshot(workspaceId: string, competitorId: string): Promise<SnapshotRecord | null> {
    let latest: SnapshotRecord | null = null;
    for (const r of this.snapshots) {
      if (r.workspaceId !== workspaceId || r.competitorId !== competitorId) continue;
      if (latest === null || r.capturedAt.getTime() > latest.capturedAt.getTime()) latest = r;
    }
    return latest ? this.cloneSnapshot(latest) : null;
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SnapshotRecord> {
    const row: SnapshotRecord = {
      id: `snap-${++this.snapSeq}`,
      workspaceId: input.workspaceId,
      competitorId: input.competitorId,
      snapshot: input.snapshot,
      capturedAt: input.capturedAt,
    };
    this.snapshots.push(row);
    return this.cloneSnapshot(row);
  }

  async saveDigest(input: SaveDigestInput): Promise<DigestRecord> {
    const row: DigestRecord = {
      id: `digest-${++this.digestSeq}`,
      workspaceId: input.workspaceId,
      digest: input.digest,
      requestedByMemberId: input.requestedByMemberId,
      generatedAt: input.generatedAt,
    };
    this.digests.push(row);
    return this.cloneDigest(row);
  }

  async getDigest(workspaceId: string, id: string): Promise<DigestRecord | null> {
    const row = this.digests.find((d) => d.id === id && d.workspaceId === workspaceId);
    return row ? this.cloneDigest(row) : null;
  }

  async listDigests(workspaceId: string, limit?: number): Promise<DigestRecord[]> {
    const rows = this.digests
      .filter((d) => d.workspaceId === workspaceId)
      .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime() || b.id.localeCompare(a.id))
      .map((d) => this.cloneDigest(d));
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  private cloneSnapshot(r: SnapshotRecord): SnapshotRecord {
    return { ...r, snapshot: structuredClone(r.snapshot) };
  }

  private cloneDigest(r: DigestRecord): DigestRecord {
    return { ...r, digest: structuredClone(r.digest) };
  }
}
