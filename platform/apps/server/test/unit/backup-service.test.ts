import { describe, it, expect } from "vitest";
import {
  WorkspaceBackupService,
  BackupError,
  type BackupDataSource,
  type RestoreSink,
} from "../../src/backup/service.js";
import { InMemoryBackupStore } from "../../src/backup/store.js";
import { buildEnvelope, type WorkspaceSnapshot } from "../../src/backup/archive.js";
import type { WorkspaceBackupCaps } from "../../src/backup/caps.js";

/**
 * Unit tests of {@link WorkspaceBackupService} over the in-memory store with fake data-source / restore-sink
 * seams — no DB. Covers: backups persist + prune to retention, export produces a restorable envelope,
 * restore round-trips and is fail-closed against tampered / foreign exports, and the scheduled tick fires
 * only when due.
 */

const WID = "ws-1";
const ENABLED: WorkspaceBackupCaps = { enabled: true, intervalHours: 24, retention: 3 };
const DISABLED: WorkspaceBackupCaps = { enabled: false, intervalHours: 24, retention: 3 };

const SNAPSHOT: WorkspaceSnapshot = {
  collections: { agent_sessions: [{ id: "s1" }, { id: "s2" }], automations: [{ id: "a1" }] },
};

class FakeDataSource implements BackupDataSource {
  constructor(public snap: WorkspaceSnapshot = SNAPSHOT) {}
  async snapshot(): Promise<WorkspaceSnapshot> {
    return this.snap;
  }
}

class RecordingRestoreSink implements RestoreSink {
  restored: { workspaceId: string; snapshot: WorkspaceSnapshot }[] = [];
  async restore(workspaceId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    this.restored.push({ workspaceId, snapshot });
  }
}

function makeService(caps: WorkspaceBackupCaps = ENABLED, clock?: { t: number }) {
  const store = new InMemoryBackupStore();
  const dataSource = new FakeDataSource();
  const restoreSink = new RecordingRestoreSink();
  const c = clock ?? { t: 1_000 };
  const service = new WorkspaceBackupService({
    store,
    dataSource,
    restoreSink,
    caps,
    now: () => new Date(c.t),
  });
  return { store, dataSource, restoreSink, service, clock: c };
}

describe("createBackup / export", () => {
  it("persists a manual backup with checksum + collection counts", async () => {
    const { service } = makeService();
    const { record, envelope } = await service.createBackup(WID, "manual");
    expect(record.kind).toBe("manual");
    expect(record.workspaceId).toBe(WID);
    expect(record.collectionCounts).toEqual({ agent_sessions: 2, automations: 1 });
    expect(record.checksum).toBe(envelope.checksum);
    expect(record.sizeBytes).toBeGreaterThan(0);
  });

  it("exportWorkspace produces a verifiable envelope and leaves a restorable record", async () => {
    const { service } = makeService();
    const envelope = await service.exportWorkspace(WID);
    expect(envelope.workspaceId).toBe(WID);
    expect(envelope.snapshot).toEqual(SNAPSHOT);
    const backups = await service.listBackups(WID);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.checksum).toBe(envelope.checksum);
  });

  it("prunes to the retention limit, keeping the newest", async () => {
    const clock = { t: 1_000 };
    const { service } = makeService(ENABLED, clock); // retention 3
    for (let i = 0; i < 5; i++) {
      clock.t += 1_000;
      await service.createBackup(WID, "manual");
    }
    const backups = await service.listBackups(WID);
    expect(backups).toHaveLength(3);
    // Newest first; createdAt strictly increasing as the clock advanced.
    expect(backups[0]!.createdAt.getTime()).toBeGreaterThan(backups[2]!.createdAt.getTime());
  });
});

describe("restoreWorkspace", () => {
  it("round-trips a produced export back through the restore sink", async () => {
    const { service, restoreSink } = makeService();
    const envelope = await service.exportWorkspace(WID);
    const result = await service.restoreWorkspace(WID, envelope);
    expect(result).toEqual({ restored: true, workspaceId: WID, collections: 2, rows: 3 });
    expect(restoreSink.restored).toHaveLength(1);
    expect(restoreSink.restored[0]!.snapshot).toEqual(SNAPSHOT);
  });

  it("rejects a tampered export and never touches the sink", async () => {
    const { service, restoreSink } = makeService();
    const envelope = await service.exportWorkspace(WID);
    const tampered = {
      ...envelope,
      snapshot: { collections: { ...envelope.snapshot.collections, automations: [{ id: "HIJACK" }] } },
    };
    await expect(service.restoreWorkspace(WID, tampered)).rejects.toBeInstanceOf(BackupError);
    expect(restoreSink.restored).toHaveLength(0);
  });

  it("refuses an export that belongs to a different workspace (#3 IDOR)", async () => {
    const { service } = makeService();
    const foreign = buildEnvelope("ws-other", SNAPSHOT, new Date(1_000));
    await expect(service.restoreWorkspace(WID, foreign)).rejects.toThrow(/different workspace/);
  });

  it("refuses garbage input", async () => {
    const { service } = makeService();
    await expect(service.restoreWorkspace(WID, { not: "an envelope" })).rejects.toBeInstanceOf(BackupError);
  });
});

describe("runScheduledBackup", () => {
  it("does nothing when disabled", async () => {
    const { service } = makeService(DISABLED);
    expect(await service.runScheduledBackup(WID)).toBeNull();
  });

  it("takes the first scheduled backup, then waits for the interval to elapse", async () => {
    const clock = { t: 0 };
    const { service } = makeService(ENABLED, clock); // intervalHours 24
    const first = await service.runScheduledBackup(WID);
    expect(first?.kind).toBe("scheduled");

    // Not yet due (1h later).
    clock.t += 60 * 60 * 1000;
    expect(await service.runScheduledBackup(WID)).toBeNull();

    // Due (24h after the first).
    clock.t = 24 * 60 * 60 * 1000;
    const second = await service.runScheduledBackup(WID);
    expect(second?.kind).toBe("scheduled");

    const scheduled = (await service.listBackups(WID)).filter((b) => b.kind === "scheduled");
    expect(scheduled).toHaveLength(2);
  });
});

describe("settings", () => {
  it("reflects the caps", () => {
    const { service } = makeService();
    expect(service.settings()).toEqual({ enabled: true, intervalHours: 24, retention: 3 });
    expect(service.enabled).toBe(true);
  });
});
