import { describe, it, expect, beforeEach } from "vitest";
import {
  CloudWorkspaceManager,
  type CloudWorkspaceStore,
  type CloudWorkspaceLogger,
  type CloudWorkspaceSandbox,
} from "../../src/workspace/manager.js";
import { InMemoryMirrorSource, InMemoryMirrorSink } from "../../src/workspace/sync.js";
import type { CloudWorkspace, CloudWorkspaceStatus } from "../../src/db/repositories/cloud-workspaces.js";

const silentLogger: CloudWorkspaceLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
};

function cw(over: Partial<CloudWorkspace> = {}): CloudWorkspace {
  return {
    id: "cw_1",
    workspaceId: "ws_1",
    name: "env",
    status: "active",
    snapshotId: null,
    setupCompleted: false,
    createdByMemberId: "mem_owner",
    lastActiveAt: new Date(0),
    createdAt: new Date(0),
    ...over,
  };
}

/** In-memory store for hermetic manager tests (no DB). */
class FakeStore implements CloudWorkspaceStore {
  rows = new Map<string, CloudWorkspace>();
  setupMarked: string[] = [];
  constructor(initial: CloudWorkspace[] = []) {
    for (const r of initial) this.rows.set(r.id, r);
  }
  get(id: string, workspaceId: string): Promise<CloudWorkspace | undefined> {
    const r = this.rows.get(id);
    return Promise.resolve(r && r.workspaceId === workspaceId ? r : undefined);
  }
  setStatus(id: string, status: CloudWorkspaceStatus): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.status = status;
    return Promise.resolve();
  }
  recordSnapshot(id: string, snapshotId: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.snapshotId = snapshotId;
      r.lastActiveAt = new Date();
    }
    return Promise.resolve();
  }
  markSetupCompleted(id: string): Promise<void> {
    this.setupMarked.push(id);
    const r = this.rows.get(id);
    if (r) r.setupCompleted = true;
    return Promise.resolve();
  }
  touch(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.lastActiveAt = new Date();
    return Promise.resolve();
  }
  listSleepCandidates(idleBefore: Date): Promise<CloudWorkspace[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.status === "active" && r.lastActiveAt < idleBefore),
    );
  }
}

describe("CloudWorkspaceManager — setup-on-first-mirror (#55)", () => {
  let store: FakeStore;
  let manager: CloudWorkspaceManager;
  beforeEach(() => {
    store = new FakeStore([cw()]);
    manager = new CloudWorkspaceManager({ store, logger: silentLogger });
  });

  it("runs setup exactly once across repeated mirrors", async () => {
    const source = new InMemoryMirrorSource({ "package.json": "{}", "src/x.ts": "export {}" });
    const sink = new InMemoryMirrorSink();
    let setupRuns = 0;
    const runSetup = (): Promise<void> => {
      setupRuns += 1;
      return Promise.resolve();
    };

    const first = await manager.syncToLocal(store.rows.get("cw_1")!, source, sink, runSetup);
    expect(first.ranSetup).toBe(true);
    expect(first.result.written.sort()).toEqual(["package.json", "src/x.ts"]);
    expect(setupRuns).toBe(1);
    expect(store.setupMarked).toEqual(["cw_1"]);

    // Second mirror: setup already done → never runs again.
    const second = await manager.syncToLocal(store.rows.get("cw_1")!, source, sink, runSetup);
    expect(second.ranSetup).toBe(false);
    expect(setupRuns).toBe(1);
    expect(second.result.written).toEqual([]); // files already mirrored
  });
});

describe("CloudWorkspaceManager — persist / sleep / wake (#55)", () => {
  it("sleeps an active workspace and wakes it, resuming from the retained snapshot", async () => {
    const store = new FakeStore([cw({ status: "active", snapshotId: "snap-123" })]);
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger });

    const slept = await manager.sleep("cw_1", "ws_1");
    expect(slept?.status).toBe("sleeping");
    expect(store.rows.get("cw_1")!.status).toBe("sleeping");

    const woken = await manager.wake("cw_1", "ws_1");
    expect(woken?.status).toBe("active");
    expect(woken?.snapshotId).toBe("snap-123"); // resume key preserved across sleep
    expect(store.rows.get("cw_1")!.status).toBe("active");
  });

  it("sleeping an already-sleeping workspace is a no-op; cross-tenant returns null", async () => {
    const store = new FakeStore([cw({ status: "sleeping" })]);
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger });
    const slept = await manager.sleep("cw_1", "ws_1");
    expect(slept?.status).toBe("sleeping");
    // wrong tenant → not found
    expect(await manager.sleep("cw_1", "other_ws")).toBeNull();
    expect(await manager.wake("cw_1", "other_ws")).toBeNull();
  });

  it("records the latest snapshot as the resume key", async () => {
    const store = new FakeStore([cw()]);
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger });
    await manager.recordSnapshot("cw_1", "snap-xyz");
    expect(store.rows.get("cw_1")!.snapshotId).toBe("snap-xyz");
  });
});

/** Records the live-microVM seam calls so we can assert sleep really snapshots+stops and wake resumes. */
class FakeSandbox implements CloudWorkspaceSandbox {
  snapshotted: string[] = [];
  resumed: { id: string; snapshotId: string | null }[] = [];
  constructor(private readonly snapshotResult: string | null = "snap-new") {}
  snapshotAndStop(cloudWorkspaceId: string): Promise<string | null> {
    this.snapshotted.push(cloudWorkspaceId);
    return Promise.resolve(this.snapshotResult);
  }
  resume(cloudWorkspaceId: string, snapshotId: string | null): Promise<void> {
    this.resumed.push({ id: cloudWorkspaceId, snapshotId });
    return Promise.resolve();
  }
}

describe("CloudWorkspaceManager — real snapshot sleep/wake via the runtime (#82)", () => {
  it("sleep snapshots+stops the live microVM and records the new snapshot as the resume key", async () => {
    const store = new FakeStore([cw({ status: "active", snapshotId: "snap-old" })]);
    const sandbox = new FakeSandbox("snap-new");
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger, sandbox });

    const slept = await manager.sleep("cw_1", "ws_1");

    expect(sandbox.snapshotted).toEqual(["cw_1"]); // the live VM was snapshot + stopped
    expect(store.rows.get("cw_1")!.snapshotId).toBe("snap-new"); // recorded on teardown
    expect(store.rows.get("cw_1")!.status).toBe("sleeping");
    expect(slept).toEqual({ status: "sleeping", snapshotId: "snap-new" });
  });

  it("sleep with no live sandbox keeps the previously retained snapshot (still sleeps)", async () => {
    const store = new FakeStore([cw({ status: "active", snapshotId: "snap-old" })]);
    const sandbox = new FakeSandbox(null); // nothing live to snapshot
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger, sandbox });

    const slept = await manager.sleep("cw_1", "ws_1");

    expect(store.rows.get("cw_1")!.snapshotId).toBe("snap-old");
    expect(slept).toEqual({ status: "sleeping", snapshotId: "snap-old" });
  });

  it("wake resumes the durable microVM from the retained snapshot (fed into the next create)", async () => {
    const store = new FakeStore([cw({ status: "sleeping", snapshotId: "snap-new" })]);
    const sandbox = new FakeSandbox();
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger, sandbox });

    const woken = await manager.wake("cw_1", "ws_1");

    expect(sandbox.resumed).toEqual([{ id: "cw_1", snapshotId: "snap-new" }]);
    expect(store.rows.get("cw_1")!.status).toBe("active");
    expect(woken).toEqual({ status: "active", snapshotId: "snap-new" });
  });

  it("without a sandbox seam (default local), sleep/wake are status-only (back-compat)", async () => {
    const store = new FakeStore([cw({ status: "active", snapshotId: "snap-123" })]);
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger });
    expect((await manager.sleep("cw_1", "ws_1"))?.snapshotId).toBe("snap-123");
    expect((await manager.wake("cw_1", "ws_1"))?.snapshotId).toBe("snap-123");
  });
});

describe("CloudWorkspaceManager — idle sweep (#55)", () => {
  it("sleeps only active workspaces idle past the threshold", async () => {
    const old = new Date(Date.now() - 60_000);
    const store = new FakeStore([
      cw({ id: "cw_idle", status: "active", lastActiveAt: old }),
      cw({ id: "cw_fresh", status: "active", lastActiveAt: new Date() }),
      cw({ id: "cw_asleep", status: "sleeping", lastActiveAt: old }),
    ]);
    const manager = new CloudWorkspaceManager({ store, logger: silentLogger });

    const slept = await manager.sweepIdle(new Date(Date.now() - 30_000));
    expect(slept).toBe(1);
    expect(store.rows.get("cw_idle")!.status).toBe("sleeping");
    expect(store.rows.get("cw_fresh")!.status).toBe("active");
  });
});
