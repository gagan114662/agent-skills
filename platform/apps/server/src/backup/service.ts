/**
 * Workspace backup + export service (issue #676).
 *
 * Two user-facing capabilities, plus the scheduled tick:
 *  - **Backup / one-click export** — gather the workspace's data into a {@link WorkspaceSnapshot}, wrap it
 *    in a checksummed {@link ExportEnvelope}, and persist it. `exportWorkspace` returns the same envelope so
 *    the route can stream it as a download. The acceptance property "a backup exists and a full export can
 *    be produced" is exactly these two paths.
 *  - **Restore** — verify an export envelope (format + version + checksum, fail-closed) and replay its
 *    snapshot through the {@link RestoreSink}. The acceptance property "…and restored" is this path; the
 *    checksum guarantees a corrupted or tampered export is refused before any data is touched.
 *  - **Scheduled backups** — `runScheduledBackup` is the seam the durable single-leader scheduler (#559)
 *    calls on a timer: it takes a `scheduled` backup only when one is due (interval elapsed since the last
 *    scheduled backup) and then prunes to the retention limit. It is a pure-decision method (clock + store
 *    injected) so it is unit-testable with no timers and no DB.
 *
 * Data gathering and restore application are abstracted behind {@link BackupDataSource} / {@link RestoreSink}
 * so this service — and its tests — stay decoupled from any specific repository or table. Wiring the
 * production data source to real repos and the scheduled tick into #559 are deliberate follow-ups (they
 * would touch shared files); see `backup/default.ts`.
 */

import {
  buildEnvelope,
  checksumSnapshot,
  collectionCounts,
  countRows,
  parseEnvelope,
  serializeEnvelope,
  verifyEnvelope,
  type ExportEnvelope,
  type WorkspaceSnapshot,
} from "./archive.js";
import { resolveWorkspaceBackupCaps, type WorkspaceBackupCaps } from "./caps.js";
import type { BackupKind, BackupRecord, BackupStore } from "./store.js";

/** Gathers a workspace's exportable data. The production binding reads the real repositories. */
export interface BackupDataSource {
  snapshot(workspaceId: string): Promise<WorkspaceSnapshot>;
}

/** Applies a restored snapshot back into the workspace. */
export interface RestoreSink {
  restore(workspaceId: string, snapshot: WorkspaceSnapshot): Promise<void>;
}

/** A backup-domain rejection (invalid restore input, disabled feature). Routes map this to 4xx. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface RestoreResult {
  restored: true;
  workspaceId: string;
  collections: number;
  rows: number;
}

export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  retention: number;
}

export interface BackupServiceDeps {
  store: BackupStore;
  dataSource: BackupDataSource;
  restoreSink: RestoreSink;
  /** Caps override (tests pass an enabled value); defaults to the env-resolved caps. */
  caps?: WorkspaceBackupCaps;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class WorkspaceBackupService {
  private readonly store: BackupStore;
  private readonly dataSource: BackupDataSource;
  private readonly restoreSink: RestoreSink;
  private readonly caps: WorkspaceBackupCaps;
  private readonly now: () => Date;

  constructor(deps: BackupServiceDeps) {
    this.store = deps.store;
    this.dataSource = deps.dataSource;
    this.restoreSink = deps.restoreSink;
    this.caps = deps.caps ?? resolveWorkspaceBackupCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the feature is enabled for this deployment (gates every route). */
  get enabled(): boolean {
    return this.caps.enabled;
  }

  /** The current settings (for the read endpoint). */
  settings(): BackupSettings {
    return {
      enabled: this.caps.enabled,
      intervalHours: this.caps.intervalHours,
      retention: this.caps.retention,
    };
  }

  /**
   * Take a backup of a workspace: snapshot → checksummed envelope → persist → prune to retention. Returns
   * the stored record and the envelope (so the manual/export path can hand the bytes back to the caller).
   */
  async createBackup(workspaceId: string, kind: BackupKind): Promise<{ record: BackupRecord; envelope: ExportEnvelope }> {
    const snapshot = await this.dataSource.snapshot(workspaceId);
    const at = this.now();
    const envelope = buildEnvelope(workspaceId, snapshot, at);
    const record = await this.store.save({
      workspaceId,
      kind,
      createdAt: at,
      checksum: envelope.checksum,
      collectionCounts: collectionCounts(snapshot),
      envelope: serializeEnvelope(envelope),
    });
    await this.store.prune(workspaceId, this.caps.retention);
    return { record, envelope };
  }

  /** A workspace's backups, newest first. */
  listBackups(workspaceId: string): Promise<BackupRecord[]> {
    return this.store.list(workspaceId);
  }

  /**
   * Produce a full, downloadable export of the workspace (the "one-click export"). This also persists a
   * `manual` backup, so an export always leaves a restorable record behind.
   */
  async exportWorkspace(workspaceId: string): Promise<ExportEnvelope> {
    const { envelope } = await this.createBackup(workspaceId, "manual");
    return envelope;
  }

  /** Load a previously stored backup's verified envelope (e.g. to re-download it); null if absent. */
  async getBackupEnvelope(workspaceId: string, id: string): Promise<ExportEnvelope | null> {
    const stored = await this.store.get(workspaceId, id);
    if (!stored) return null;
    const parsed = parseEnvelope(stored.envelope);
    if (!parsed.ok) throw new BackupError(`stored backup is corrupt: ${parsed.reason}`);
    return parsed.envelope;
  }

  /**
   * Restore a workspace from an export envelope. Validates the envelope (format/version/checksum,
   * fail-closed) and that it belongs to *this* workspace (#3 IDOR — you cannot restore another tenant's
   * export into yours), then replays the snapshot through the {@link RestoreSink}. Throws {@link BackupError}
   * on any validation failure, before the sink is touched.
   */
  async restoreWorkspace(workspaceId: string, envelopeValue: unknown): Promise<RestoreResult> {
    const verdict = verifyEnvelope(envelopeValue);
    if (!verdict.ok) throw new BackupError(`invalid export: ${verdict.reason}`);
    const envelope = envelopeValue as ExportEnvelope;
    if (envelope.workspaceId !== workspaceId) {
      throw new BackupError("export belongs to a different workspace");
    }
    // Defence-in-depth: re-derive the checksum (verifyEnvelope already did, but keep restore self-sufficient).
    if (checksumSnapshot(envelope.snapshot) !== envelope.checksum) {
      throw new BackupError("invalid export: checksum mismatch");
    }
    await this.restoreSink.restore(workspaceId, envelope.snapshot);
    return {
      restored: true,
      workspaceId,
      collections: Object.keys(envelope.snapshot.collections).length,
      rows: countRows(envelope.snapshot),
    };
  }

  /**
   * The scheduler tick (#559 seam). Takes a `scheduled` backup only if one is due — i.e. there is no prior
   * scheduled backup, or the newest one is older than the configured interval. Returns the new record, or
   * null when not due / disabled. Pruning happens inside {@link createBackup}.
   */
  async runScheduledBackup(workspaceId: string): Promise<BackupRecord | null> {
    if (!this.caps.enabled) return null;
    const backups = await this.store.list(workspaceId);
    const lastScheduled = backups.find((b) => b.kind === "scheduled");
    if (lastScheduled && !this.isDue(lastScheduled.createdAt)) return null;
    const { record } = await this.createBackup(workspaceId, "scheduled");
    return record;
  }

  /** Whether `intervalHours` have elapsed since `since`, per the injected clock. */
  private isDue(since: Date): boolean {
    const elapsedMs = this.now().getTime() - since.getTime();
    return elapsedMs >= this.caps.intervalHours * 60 * 60 * 1000;
  }
}
