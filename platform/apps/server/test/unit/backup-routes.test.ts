import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WorkspaceBackupService, type BackupDataSource, type RestoreSink } from "../../src/backup/service.js";
import { InMemoryBackupStore } from "../../src/backup/store.js";
import type { WorkspaceSnapshot } from "../../src/backup/archive.js";
import type { WorkspaceBackupCaps } from "../../src/backup/caps.js";

/**
 * Hermetic unit test of the backup/export HTTP contract (issue #676): auth + capability guards are mocked,
 * the service runs over an in-memory store with fake seams — so this proves the route logic (caps gate,
 * IDOR scoping, restore admin-gating, validation) with no Postgres.
 */

const IDENTITY = { workspaceId: "w1", memberId: "m1", kind: "human" as const, displayName: "Ada" };
const state = { identity: IDENTITY as typeof IDENTITY | null, hasCapability: true };

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!state.identity) {
      reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    return state.identity;
  }),
  assertWorkspace: vi.fn(
    (id: { workspaceId: string }, wid: string, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      if (id.workspaceId !== wid) {
        reply.code(403).send({ error: "wrong workspace" });
        return false;
      }
      return true;
    },
  ),
}));

vi.mock("../../src/auth/access.js", () => ({
  requireMemoryCapability: vi.fn(
    async (_id: unknown, _wid: unknown, _cap: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      if (!state.hasCapability) {
        reply.code(403).send({ error: "forbidden" });
        return false;
      }
      return true;
    },
  ),
}));

const { backupRoutes } = await import("../../src/routes/backup.js");

const SNAPSHOT: WorkspaceSnapshot = { collections: { agent_sessions: [{ id: "s1" }] } };
const ENABLED: WorkspaceBackupCaps = { enabled: true, intervalHours: 24, retention: 5 };
const DISABLED: WorkspaceBackupCaps = { enabled: false, intervalHours: 24, retention: 5 };

class FakeDataSource implements BackupDataSource {
  async snapshot(): Promise<WorkspaceSnapshot> {
    return SNAPSHOT;
  }
}
class NoopRestoreSink implements RestoreSink {
  restored = 0;
  async restore(): Promise<void> {
    this.restored++;
  }
}

async function buildApp(caps: WorkspaceBackupCaps): Promise<{ app: FastifyInstance; sink: NoopRestoreSink; service: WorkspaceBackupService }> {
  const sink = new NoopRestoreSink();
  const service = new WorkspaceBackupService({
    store: new InMemoryBackupStore(),
    dataSource: new FakeDataSource(),
    restoreSink: sink,
    caps,
    now: () => new Date(1_000),
  });
  const app = Fastify();
  await app.register(backupRoutes, { service });
  await app.ready();
  return { app, sink, service };
}

beforeEach(() => {
  state.identity = IDENTITY;
  state.hasCapability = true;
});

describe("auth + caps gate", () => {
  it("401 when unauthenticated", async () => {
    state.identity = null;
    const { app } = await buildApp(ENABLED);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/backup" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 on cross-workspace access (#3 IDOR)", async () => {
    const { app } = await buildApp(ENABLED);
    const res = await app.inject({ method: "GET", url: "/workspaces/w2/backup" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("409 when the feature is disabled", async () => {
    const { app } = await buildApp(DISABLED);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/backup" });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("backup + export endpoints", () => {
  it("GET returns settings and the (initially empty) backup list", async () => {
    const { app } = await buildApp(ENABLED);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/backup" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, settings: { enabled: true, retention: 5 }, backups: [] });
    await app.close();
  });

  it("POST takes a manual backup (201) that then appears in the list", async () => {
    const { app } = await buildApp(ENABLED);
    const post = await app.inject({ method: "POST", url: "/workspaces/w1/backup" });
    expect(post.statusCode).toBe(201);
    expect(post.json().backup).toMatchObject({ kind: "manual", workspaceId: "w1" });
    const list = await app.inject({ method: "GET", url: "/workspaces/w1/backup" });
    expect(list.json().backups).toHaveLength(1);
    await app.close();
  });

  it("GET export streams a downloadable, verifiable envelope", async () => {
    const { app } = await buildApp(ENABLED);
    const res = await app.inject({ method: "GET", url: "/workspaces/w1/backup/export" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    const env = JSON.parse(res.body);
    expect(env.format).toBe("workspace-backup");
    expect(env.workspaceId).toBe("w1");
    expect(env.snapshot).toEqual(SNAPSHOT);
    await app.close();
  });
});

describe("restore endpoint", () => {
  it("restores from a freshly produced export (round-trip)", async () => {
    const { app, sink } = await buildApp(ENABLED);
    const exported = await app.inject({ method: "GET", url: "/workspaces/w1/backup/export" });
    const envelope = JSON.parse(exported.body);
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/w1/backup/restore",
      payload: { envelope },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restored: true, workspaceId: "w1" });
    expect(sink.restored).toBe(1);
    await app.close();
  });

  it("403 without the propagate capability (restore is admin-only)", async () => {
    state.hasCapability = false;
    const { app, sink } = await buildApp(ENABLED);
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/w1/backup/restore",
      payload: { envelope: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(sink.restored).toBe(0);
    await app.close();
  });

  it("422 on a malformed export", async () => {
    const { app } = await buildApp(ENABLED);
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/w1/backup/restore",
      payload: { envelope: { format: "evil" } },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
