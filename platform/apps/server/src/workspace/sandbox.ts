import type { ResourceCaps } from "../runtime/types.js";
import type {
  SandboxGitSource,
  SandboxInstance,
  SandboxProvider,
} from "../runtime/sandbox.js";
import type { CloudWorkspaceSandbox } from "./manager.js";

export interface ProviderCloudWorkspaceSandboxOptions {
  /** Hard resource + wall-clock caps applied to the durable cloud-workspace microVM. */
  caps: ResourceCaps;
  /** Optional repo cloned into the durable sandbox (agent-on-a-branch); from `SANDBOX_REPO_URL`. */
  source?: SandboxGitSource;
}

/**
 * Runtime-backed {@link CloudWorkspaceSandbox} (#82). Wraps the #25 {@link SandboxProvider} so a
 * cloud workspace's sleep/wake is a REAL microVM snapshot/resume — not a bare DB status flip:
 *
 *   - `resume(cwId, snapshotId)` provisions the durable sandbox, feeding `snapshotId` into
 *     `SandboxCreateOpts.snapshotId` (the #25 fast-wake resume key) — or a fresh VM when null.
 *   - `snapshotAndStop(cwId)` captures the live sandbox's filesystem and reaps it, returning the
 *     new snapshot id (which the manager records as the workspace's resume key).
 *
 * One live sandbox per cloud workspace is tracked in-process. Only wired when `AGENT_RUNTIME=sandbox`
 * (see `workspace/default.ts`); the default `local`/`demo` posture has no microVM, so the manager's
 * sleep/wake stay status-only there.
 */
export class ProviderCloudWorkspaceSandbox implements CloudWorkspaceSandbox {
  /** cloudWorkspaceId → the live durable microVM (present between a wake and the next sleep). */
  private readonly live = new Map<string, SandboxInstance>();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly options: ProviderCloudWorkspaceSandboxOptions,
  ) {}

  async resume(cloudWorkspaceId: string, snapshotId: string | null): Promise<void> {
    // Idempotent: a sandbox is already live for this workspace → nothing to provision.
    if (this.live.has(cloudWorkspaceId)) return;
    const sandbox = await this.provider.create({
      sessionId: cloudWorkspaceId,
      workspaceId: cloudWorkspaceId,
      env: {},
      secrets: {},
      caps: this.options.caps,
      source: this.options.source,
      // The retained snapshot is the fast-wake resume key; null → a fresh durable environment.
      snapshotId: snapshotId ?? undefined,
    });
    this.live.set(cloudWorkspaceId, sandbox);
  }

  async snapshotAndStop(cloudWorkspaceId: string): Promise<string | null> {
    const sandbox = this.live.get(cloudWorkspaceId);
    if (!sandbox) return null; // nothing live to snapshot
    this.live.delete(cloudWorkspaceId);
    const snapshotId = await sandbox.snapshot();
    await sandbox.stop();
    return snapshotId;
  }
}
