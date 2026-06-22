/**
 * Persistence seam for workspace backups (issue #676). The narrow interface the service consumes: store a
 * backup (its metadata + the serialized export envelope), list/load a workspace's backups, and prune to a
 * retention limit. The production binding is the self-managed Postgres store in `backup/default.ts`; unit
 * tests inject {@link InMemoryBackupStore}, so the service is tested with no database (the #17
 * pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a
 * caller can only ever read or mutate its own tenant's backups — the #3 IDOR boundary.
 */

/** Whether a backup was produced by the scheduler or by an explicit user action. */
export type BackupKind = "scheduled" | "manual";

/** Backup metadata — everything about a stored backup except the (potentially large) envelope payload. */
export interface BackupRecord {
  id: string;
  workspaceId: string;
  kind: BackupKind;
  createdAt: Date;
  /** SHA-256 (hex) of the envelope's snapshot — lets the UI show integrity without loading the payload. */
  checksum: string;
  /** Byte length of the serialized envelope. */
  sizeBytes: number;
  /** Per-collection row counts captured in this backup. */
  collectionCounts: Record<string, number>;
}

export interface StoredBackup {
  record: BackupRecord;
  /** The serialized {@link import("./archive.js").ExportEnvelope} this backup can be restored from. */
  envelope: string;
}

export interface SaveBackupInput {
  workspaceId: string;
  kind: BackupKind;
  createdAt: Date;
  checksum: string;
  collectionCounts: Record<string, number>;
  envelope: string;
}

export interface BackupStore {
  /** Persist a new backup; returns its assigned record. */
  save(input: SaveBackupInput): Promise<BackupRecord>;
  /** A workspace's backups, newest first. */
  list(workspaceId: string): Promise<BackupRecord[]>;
  /** Load one backup (metadata + envelope) within a workspace (#3 IDOR scoping); null if absent. */
  get(workspaceId: string, id: string): Promise<StoredBackup | null>;
  /** Delete all but the newest `keep` backups for a workspace; returns the number deleted. */
  prune(workspaceId: string, keep: number): Promise<number>;
}

/**
 * In-memory {@link BackupStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * supplied by the caller via {@link SaveBackupInput.createdAt}, so a test never depends on wall-clock time
 * or a uuid.
 */
export class InMemoryBackupStore implements BackupStore {
  private readonly backups = new Map<string, StoredBackup>();
  private seq = 0;

  async save(input: SaveBackupInput): Promise<BackupRecord> {
    const id = `backup-${++this.seq}`;
    const record: BackupRecord = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      createdAt: input.createdAt,
      checksum: input.checksum,
      sizeBytes: Buffer.byteLength(input.envelope, "utf8"),
      collectionCounts: { ...input.collectionCounts },
    };
    this.backups.set(id, { record, envelope: input.envelope });
    return { ...record };
  }

  async list(workspaceId: string): Promise<BackupRecord[]> {
    return this.sortedFor(workspaceId).map((b) => ({ ...b.record }));
  }

  async get(workspaceId: string, id: string): Promise<StoredBackup | null> {
    const stored = this.backups.get(id);
    if (!stored || stored.record.workspaceId !== workspaceId) return null;
    return { record: { ...stored.record }, envelope: stored.envelope };
  }

  async prune(workspaceId: string, keep: number): Promise<number> {
    const ordered = this.sortedFor(workspaceId);
    const doomed = ordered.slice(Math.max(0, keep));
    for (const b of doomed) this.backups.delete(b.record.id);
    return doomed.length;
  }

  /** A workspace's backups, newest first; ties broken by id descending (monotonic ⇒ insertion order). */
  private sortedFor(workspaceId: string): StoredBackup[] {
    return [...this.backups.values()]
      .filter((b) => b.record.workspaceId === workspaceId)
      .sort(
        (a, b) =>
          b.record.createdAt.getTime() - a.record.createdAt.getTime() ||
          b.record.id.localeCompare(a.record.id),
      );
  }
}
