import { describe, it, expect } from "vitest";
import {
  WorkspaceBackupService,
  type BackupDataSource,
  type RestoreSink,
} from "../../src/backup/service.js";
import { InMemoryBackupStore } from "../../src/backup/store.js";
import { serializeEnvelope, parseEnvelope, type WorkspaceSnapshot } from "../../src/backup/archive.js";
import type { WorkspaceBackupCaps } from "../../src/backup/caps.js";

/**
 * Acceptance test for issue #676 — verbatim against the stated criteria:
 *   "a backup exists and a full export can be produced and restored."
 *
 * It drives the whole feature end to end with no DB:
 *   1. a SCHEDULED backup is taken by the timer seam   → "a backup exists"
 *   2. a FULL export is produced and survives a serialize → download → upload → parse round-trip
 *   3. the export is RESTORED and the restored data is byte-for-byte the original snapshot
 */

const WID = "ws-acceptance";
const CAPS: WorkspaceBackupCaps = { enabled: true, intervalHours: 24, retention: 7 };

// A representative workspace dataset spanning several collections.
const LIVE_DATA: WorkspaceSnapshot = {
  collections: {
    agent_sessions: [
      { id: "s1", status: "completed", model: "claude-opus-4-8" },
      { id: "s2", status: "failed", model: "claude-sonnet-4-6" },
    ],
    automations: [{ id: "auto1", name: "nightly-digest", enabled: true }],
    approval_requests: [{ id: "ap1", kind: "publish", status: "pending" }],
  },
};

class LiveDataSource implements BackupDataSource {
  async snapshot(): Promise<WorkspaceSnapshot> {
    // Return a deep copy so the export is decoupled from the live object.
    return JSON.parse(JSON.stringify(LIVE_DATA));
  }
}

class CapturingRestoreSink implements RestoreSink {
  applied: WorkspaceSnapshot | null = null;
  async restore(_workspaceId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    this.applied = snapshot;
  }
}

describe("issue #676 acceptance", () => {
  it("a scheduled backup exists, a full export is produced, and it can be restored", async () => {
    const clock = { t: 0 };
    const restoreSink = new CapturingRestoreSink();
    const service = new WorkspaceBackupService({
      store: new InMemoryBackupStore(),
      dataSource: new LiveDataSource(),
      restoreSink,
      caps: CAPS,
      now: () => new Date(clock.t),
    });

    // 1. The scheduler tick takes a backup → "a backup exists".
    const scheduled = await service.runScheduledBackup(WID);
    expect(scheduled).not.toBeNull();
    expect(scheduled!.kind).toBe("scheduled");
    const backups = await service.listBackups(WID);
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // 2. A full export is produced and survives a download/upload round-trip.
    const exported = await service.exportWorkspace(WID);
    const wire = serializeEnvelope(exported); // what the user downloads
    const parsed = parseEnvelope(wire); // what the user later uploads
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);

    // 3. Restoring the uploaded export reproduces the original workspace data exactly.
    const result = await service.restoreWorkspace(WID, parsed.envelope);
    expect(result.restored).toBe(true);
    expect(result.collections).toBe(3);
    expect(result.rows).toBe(4);
    expect(restoreSink.applied).toEqual(LIVE_DATA);
  });
});
