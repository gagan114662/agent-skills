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

/**
 * The live-microVM seam (#82): lets `sleep()` snapshot+stop the running sandbox backing a cloud
 * workspace and `wake()` resume a durable sandbox from the retained snapshot. The real impl
 * (`ProviderCloudWorkspaceSandbox`) wraps the #25 {@link SandboxProvider}; tests inject a fake.
 * Absent (the default `local`/`demo` posture — no microVM to snapshot) → sleep/wake are a pure
 * status transition exactly as before, so wiring it in changes nothing for that path.
 */
export interface CloudWorkspaceSandbox {
  /**
   * Snapshot + stop the live microVM backing this cloud workspace. Returns the new snapshot id
   * (the resume key recorded on the workspace), or `null` if no sandbox is currently live.
   */
  snapshotAndStop(cloudWorkspaceId: string): Promise<string | null>;
  /**
   * Resume (provision) the durable microVM from `snapshotId` — fed into the next
   * `SandboxCreateOpts.snapshotId`. `null` snapshot → a fresh sandbox. Idempotent per workspace.
   */
  resume(cloudWorkspaceId: string, snapshotId: string | null): Promise<void>;
}

export interface CloudWorkspaceManagerDeps {
  store: CloudWorkspaceStore;
  logger: CloudWorkspaceLogger;
  /**
   * Optional live-microVM seam (#82). When present, `sleep()` snapshots+stops the live sandbox and
   * `wake()` resumes it; when absent, both are status-only (the default local/demo behavior).
   */
  sandbox?: CloudWorkspaceSandbox;
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

  /**
   * Put an active workspace to sleep. When a live microVM is wired (#82, sandbox runtime) this
   * snapshots + stops it and records the snapshot as the resume key; otherwise it is a status-only
   * transition retaining the last snapshot. Idempotent.
   */
  async sleep(id: string, workspaceId: string): Promise<CloudWorkspaceState | null> {
    const cw = await this.deps.store.get(id, workspaceId);
    if (!cw) return null;
    let snapshotId = cw.snapshotId;
    if (cw.status === "active") {
      // Snapshot + stop the live microVM via the runtime, then persist the new resume key. A null
      // result means nothing was live to snapshot → keep the previously retained snapshot.
      const fresh = await this.deps.sandbox?.snapshotAndStop(id);
      if (fresh) {
        await this.deps.store.recordSnapshot(id, fresh);
        snapshotId = fresh;
      }
      await this.deps.store.setStatus(id, "sleeping");
      recordCloudWorkspaceSleep();
      this.deps.logger.info({ cloudWorkspaceId: id, workspaceId, snapshotId }, "cloud workspace slept");
    }
    return { status: "sleeping", snapshotId };
  }

  /**
   * Wake a sleeping/archived workspace. When a live microVM is wired (#82) this resumes a durable
   * sandbox from the retained snapshot (fed into the next `SandboxCreateOpts.snapshotId`); either
   * way it returns the snapshot the next session resumes from.
   */
  async wake(id: string, workspaceId: string): Promise<CloudWorkspaceState | null> {
    const cw = await this.deps.store.get(id, workspaceId);
    if (!cw) return null;
    if (cw.status !== "active") {
      // Resume the durable microVM from the retained snapshot (the #25 fast-wake path).
      await this.deps.sandbox?.resume(id, cw.snapshotId);
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
