import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { getCloudWorkspace } from "../../src/db/repositories/cloud-workspaces.js";
import { createDefaultCloudWorkspaceManager } from "../../src/workspace/default.js";
import { InMemoryMirrorSource, FsMirrorSink } from "../../src/workspace/sync.js";
import type { CloudWorkspaceLogger } from "../../src/workspace/manager.js";
import type { ServerEvent } from "../../src/realtime/protocol.js";

const silentLogger: CloudWorkspaceLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
};

let app: FastifyInstance;
let wsUrl: string;
const slugs: string[] = [];
const tmpDirs: string[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

interface Owner {
  cookie: string;
  workspaceId: string;
  memberId: string;
}

/** Sign up a fresh human owner in a fresh workspace. */
async function newOwner(): Promise<Owner> {
  const slug = `cws-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

/** Register an agent member (used as a second collaborator) with a Bearer token. */
async function newAgent(owner: Owner, name: string): Promise<{ memberId: string; token: string }> {
  const reg = (
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/agents`,
      cookies: { rid: owner.cookie },
      payload: { name },
    })
  ).json();
  return { memberId: reg.memberId, token: reg.token };
}

async function createCloudWorkspace(owner: Owner, name: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${owner.workspaceId}/cloud-workspaces`,
    cookies: { rid: owner.cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** A WS connection that records every server event for later assertions. */
interface LiveSocket {
  socket: WebSocket;
  events: ServerEvent[];
  waitFor(pred: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  send(cmd: unknown): void;
  close(): void;
}

async function connect(auth: { cookie?: string; token?: string }): Promise<LiveSocket> {
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = `rid=${auth.cookie}`;
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  const socket = new WebSocket(wsUrl, { headers });
  const events: ServerEvent[] = [];
  socket.on("message", (data) => {
    try {
      events.push(JSON.parse(data.toString()) as ServerEvent);
    } catch {
      /* ignore non-JSON frames */
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    // Resolve only once the server has sent `ready` — by then its message listener is attached,
    // so commands we send next can't race the gateway's post-handshake setup.
    const check = setInterval(() => {
      if (events.some((e) => e.type === "ready")) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  return {
    socket,
    events,
    async waitFor(pred, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline)
          throw new Error(`timed out; saw: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    send(cmd) {
      socket.send(JSON.stringify(cmd));
    },
    close() {
      socket.terminate();
    },
  };
}

describe("cloud↔local sync + persistent & shared workspaces (real Postgres + Redis)", () => {
  it("mirrors cloud files locally and runs setup exactly once (setup-on-first-mirror)", async () => {
    const owner = await newOwner();
    const cwId = await createCloudWorkspace(owner, "env");
    const cw = (await getCloudWorkspace(cwId, owner.workspaceId))!;

    const manager = createDefaultCloudWorkspaceManager(silentLogger);
    const localDir = mkdtempSync(join(tmpdir(), "reload-cws-"));
    tmpDirs.push(localDir);
    const sink = new FsMirrorSink(localDir);
    const source = new InMemoryMirrorSource({
      "package.json": '{"name":"app"}',
      "src/index.ts": "export const x = 1;",
    });

    let setupRuns = 0;
    const runSetup = (): Promise<void> => {
      setupRuns += 1;
      return Promise.resolve();
    };

    const first = await manager.syncToLocal(cw, source, sink, runSetup);
    expect(first.ranSetup).toBe(true);
    expect(readFileSync(join(localDir, "package.json"), "utf8")).toBe('{"name":"app"}');
    expect(readFileSync(join(localDir, "src/index.ts"), "utf8")).toBe("export const x = 1;");
    expect(setupRuns).toBe(1);

    // The flag is persisted: re-fetch and mirror again → setup never runs a second time.
    const cw2 = (await getCloudWorkspace(cwId, owner.workspaceId))!;
    expect(cw2.setupCompleted).toBe(true);
    const second = await manager.syncToLocal(cw2, source, sink, runSetup);
    expect(second.ranSetup).toBe(false);
    expect(setupRuns).toBe(1);
  });

  it("shares a workspace with a scoped collaborator who sees live presence; revoke cuts access", async () => {
    const owner = await newOwner();
    const collab = await newAgent(owner, "Collaborator");
    const cwId = await createCloudWorkspace(owner, "shared-env");

    // Before invite: the collaborator cannot see the workspace (collaborator-gated → 404).
    const before = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}`,
      headers: { authorization: `Bearer ${collab.token}` },
    });
    expect(before.statusCode).toBe(404);

    // Owner invites the collaborator at read.
    const invite = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}/collaborators`,
      cookies: { rid: owner.cookie },
      payload: { memberId: collab.memberId, capability: "read" },
    });
    expect(invite.statusCode).toBe(201);

    // Now the collaborator can read it.
    const after = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}`,
      headers: { authorization: `Bearer ${collab.token}` },
    });
    expect(after.statusCode).toBe(200);

    // Live presence: the owner watches, then the collaborator joins → owner sees them join.
    const ownerWs = await connect({ cookie: owner.cookie });
    ownerWs.send({ type: "watch", cloudWorkspaceId: cwId });
    await ownerWs.waitFor((e) => e.type === "watching");

    const collabWs = await connect({ token: collab.token });
    collabWs.send({ type: "watch", cloudWorkspaceId: cwId });
    await collabWs.waitFor((e) => e.type === "watching");

    const joined = await ownerWs.waitFor(
      (e) => e.type === "workspace_presence" && e.presence.memberId === collab.memberId,
    );
    expect(joined.type === "workspace_presence" && joined.presence.status).toBe("joined");

    // Revoke → the collaborator's live watch is cut (access_revoked) and REST access is gone.
    const revoke = await app.inject({
      method: "DELETE",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}/collaborators/${collab.memberId}`,
      cookies: { rid: owner.cookie },
    });
    expect(revoke.statusCode).toBe(200);

    const revoked = await collabWs.waitFor(
      (e) => e.type === "access_revoked" && e.cloudWorkspaceId === cwId,
    );
    expect(revoked.type).toBe("access_revoked");

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}`,
      headers: { authorization: `Bearer ${collab.token}` },
    });
    expect(afterRevoke.statusCode).toBe(404); // IDOR-safe: cut access reads as not-found

    // A revoked collaborator can no longer re-watch live either.
    collabWs.send({ type: "watch", cloudWorkspaceId: cwId });
    const forbidden = await collabWs.waitFor((e) => e.type === "error");
    expect(forbidden.type === "error" && forbidden.code).toBe("forbidden");

    ownerWs.close();
    collabWs.close();
  });

  it("sleeps a workspace and wakes it, resuming from the retained snapshot", async () => {
    const owner = await newOwner();
    const cwId = await createCloudWorkspace(owner, "durable-env");

    // A session teardown records the latest snapshot (resume key) on the workspace.
    const manager = createDefaultCloudWorkspaceManager(silentLogger);
    await manager.recordSnapshot(cwId, "snap-resume-1");

    const sleep = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}/sleep`,
      cookies: { rid: owner.cookie },
    });
    expect(sleep.statusCode).toBe(200);
    expect(sleep.json().status).toBe("sleeping");

    const slept = (await getCloudWorkspace(cwId, owner.workspaceId))!;
    expect(slept.status).toBe("sleeping");
    expect(slept.snapshotId).toBe("snap-resume-1"); // snapshot retained across sleep

    const wake = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/cloud-workspaces/${cwId}/wake`,
      cookies: { rid: owner.cookie },
    });
    expect(wake.statusCode).toBe(200);
    expect(wake.json().status).toBe("active");
    expect(wake.json().snapshotId).toBe("snap-resume-1"); // resumes from the retained snapshot
  });

  it("cannot read a cloud workspace from another tenant (IDOR)", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const cwId = await createCloudWorkspace(a, "a-only");

    // B uses its own tenant id in the path but A's cloud workspace id → not found.
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${b.workspaceId}/cloud-workspaces/${cwId}`,
      cookies: { rid: b.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
