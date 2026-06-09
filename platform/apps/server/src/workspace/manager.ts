import type { CloudWorkspace, CloudWorkspaceStatus } from "../db/repositories/cloud-workspaces.js";
import {
  recordCloudWorkspaceSleep,
  recordCloudWorkspaceWake,
  recordCloudWorkspaceSync,
} from "../observability/metrics.js";
import { mirror, type MirrorSink, type MirrorSource, type SyncResult } from "./sync.js";

/** Persistence seam (real impl wraps the cloud-workspaces repository; tests inject a fake). */
export interface CloudWorkspaceStore {
  get(id: string, workspaceId: string): Promise<CloudWorkspace | undefined>;
  setStatus(id: string, status: CloudWorkspaceStatus): Promise<void>;
  recordSnapshot(id: string, snapshotId: string): Promise<void>;
  markSetupCompleted(id: string): Promise<void>;
  touch(id: string): Promise<void>;
  listSleepCandidates(idleBefore: Date): Promise<CloudWorkspace[]>;
}

/** Minimal structural logger — Fastify's pino `app.log` satisfies this; tests pass a no-op. */
export interface CloudWorkspaceLogger {
  child(bindings: Record<string, unknown>): CloudWorkspaceLogger;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface CloudWorkspaceManagerDeps {
  store: CloudWorkspaceStore;
  logger: CloudWorkspaceLogger;
}

/** What a sleep/wake transition returns (the snapshot is the resume key for wake). */
export interface CloudWorkspaceState {
  status: CloudWorkspaceStatus;
  snapshotId: string | null;
}

export interface SyncToLocalResult {
  result: SyncResult;
  /** True when this mirror triggered the one-time setup (setup-on-first-mirror). */
  ranSetup: boolean;
}

/**
 * CloudWorkspaceManager — the server-owned orchestrator for durable & shared cloud workspaces
 * (#55, ADR-0032). It makes cloud work persistent (sleep/wake around the #25 snapshot resume key),
 * mirrors cloud files to a local directory with a one-time setup, and provides an idle sweep that
 * sleeps unused workspaces to save resources. Sharing/RBAC + presence live in the routes/realtime
 * layers (reusing #9 + #5); this class owns the lifecycle and sync mechanics.
 */
export class CloudWorkspaceManager {
  constructor(private readonly deps: CloudWorkspaceManagerDeps) {}

  /** Put an active workspace to sleep (snapshot retained for fast wake). Idempotent. */
  async sleep(id: string, workspaceId: string): Promise<CloudWorkspaceState | null> {
    const cw = await this.deps.store.get(id, workspaceId);
    if (!cw) return null;
    if (cw.status === "active") {
      await this.deps.store.setStatus(id, "sleeping");
      recordCloudWorkspaceSleep();
      this.deps.logger.info({ cloudWorkspaceId: id, workspaceId }, "cloud workspace slept");
    }
    return { status: "sleeping", snapshotId: cw.snapshotId };
  }

  /** Wake a sleeping/archived workspace, returning the snapshot to resume the next session from. */
  async wake(id: string, workspaceId: string): Promise<CloudWorkspaceState | null> {
    const cw = await this.deps.store.get(id, workspaceId);
    if (!cw) return null;
    if (cw.status !== "active") {
      await this.deps.store.setStatus(id, "active");
      await this.deps.store.touch(id);
      recordCloudWorkspaceWake();
      this.deps.logger.info(
        { cloudWorkspaceId: id, workspaceId, snapshotId: cw.snapshotId },
        "cloud workspace woken",
      );
    }
    return { status: "active", snapshotId: cw.snapshotId };
  }

  /** Record the latest filesystem snapshot (called when a #25 session tears down). */
  async recordSnapshot(id: string, snapshotId: string): Promise<void> {
    await this.deps.store.recordSnapshot(id, snapshotId);
  }

  /**
   * Mirror a cloud workspace's files to a local sink and run the one-time setup the FIRST time
   * only. The `setupCompleted` flag is the gate; once set, repeated mirrors never re-run setup.
   */
  async syncToLocal(
    cw: CloudWorkspace,
    source: MirrorSource,
    sink: MirrorSink,
    runSetup: () => Promise<void>,
  ): Promise<SyncToLocalResult> {
    const result = await mirror(source, sink);
    recordCloudWorkspaceSync(result.written.length);
    let ranSetup = false;
    if (!cw.setupCompleted) {
      await runSetup();
      await this.deps.store.markSetupCompleted(cw.id);
      ranSetup = true;
      this.deps.logger.info(
        { cloudWorkspaceId: cw.id, workspaceId: cw.workspaceId },
        "cloud workspace setup ran (first mirror)",
      );
    }
    return { result, ranSetup };
  }

  /** Sleep every active workspace idle since before `idleBefore`. Returns how many were slept. */
  async sweepIdle(idleBefore: Date): Promise<number> {
    const candidates = await this.deps.store.listSleepCandidates(idleBefore);
    for (const cw of candidates) {
      await this.deps.store.setStatus(cw.id, "sleeping");
      recordCloudWorkspaceSleep();
    }
    if (candidates.length > 0) {
      this.deps.logger.info({ slept: candidates.length }, "cloud workspace idle sweep");
    }
    return candidates.length;
  }
}
