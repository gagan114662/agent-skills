import { describe, it, expect, beforeEach } from "vitest";
import {
  DeployManager,
  DeployEgressBlocked,
  NoDeployConfigError,
  NoRollbackTargetError,
  type DeploymentStore,
} from "../../src/deploy/manager.js";
import type {
  CreateDeploymentInput,
  Deployment,
  UpdateDeploymentFields,
} from "../../src/db/repositories/deployments.js";
import { DryRunDeployProvider } from "../../src/deploy/dry-run-provider.js";
import { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";
import type { ChannelPoster } from "../../src/runtime/manager.js";
import type { DeployLogEvent, DeployStatusEvent } from "../../src/realtime/protocol.js";

/** A hermetic in-memory deployment store — stands in for the DB (no Postgres). */
class MemoryStore implements DeploymentStore {
  rows: Deployment[] = [];
  private seq = 0;

  create(input: CreateDeploymentInput): Promise<Deployment> {
    const now = new Date(Date.now() + this.seq); // monotonic so "newest first" is stable
    const row: Deployment = {
      id: `dep_${++this.seq}`,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      sessionId: input.sessionId,
      provider: input.provider,
      status: input.status,
      url: null,
      providerDeploymentId: null,
      framework: input.framework ?? null,
      error: null,
      reason: input.reason ?? null,
      rolledBackFromId: input.rolledBackFromId ?? null,
      logs: [],
      createdByMemberId: input.createdByMemberId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  update(id: string, fields: UpdateDeploymentFields): Promise<Deployment> {
    const row = this.rows.find((r) => r.id === id)!;
    Object.assign(row, fields, { updatedAt: new Date() });
    return Promise.resolve({ ...row });
  }

  get(id: string, channelId: string): Promise<Deployment | undefined> {
    const row = this.rows.find((r) => r.id === id && r.channelId === channelId);
    return Promise.resolve(row ? { ...row } : undefined);
  }

  latestForSession(sessionId: string, channelId: string): Promise<Deployment | undefined> {
    const row = [...this.rows]
      .filter((r) => r.sessionId === sessionId && r.channelId === channelId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return Promise.resolve(row ? { ...row } : undefined);
  }

  listForSession(sessionId: string, channelId: string): Promise<Deployment[]> {
    const rows = [...this.rows]
      .filter((r) => r.sessionId === sessionId && r.channelId === channelId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }
}

const SECRET = "sk-supersecret-value-123";

interface Harness {
  manager: DeployManager;
  store: MemoryStore;
  provider: DryRunDeployProvider;
  events: (DeployStatusEvent | DeployLogEvent)[];
  posts: string[];
}

function makeHarness(cfg: Partial<ResolvedConfig> = {}): Harness {
  const store = new MemoryStore();
  const provider = new DryRunDeployProvider();
  const events: (DeployStatusEvent | DeployLogEvent)[] = [];
  const posts: string[] = [];
  const poster: ChannelPoster = {
    post: (input) => {
      posts.push(input.body);
      return Promise.resolve({ id: "msg_1" });
    },
  };
  const manager = new DeployManager({
    provider,
    loadConfig: () => ({ ...CONFIG_DEFAULTS, deploy: { provider: "dryrun" }, ...cfg }),
    secrets: new StaticSecretsResolver({ MY_SECRET: SECRET }),
    provisioner: { prepare: () => Promise.resolve({ cwd: undefined }) },
    store,
    poster,
    publish: (_cid, event) => events.push(event),
  });
  return { manager, store, provider, events, posts };
}

const REQ = {
  sessionId: "sess_1",
  workspaceId: "ws_1",
  channelId: "chan_1",
  agentMemberId: "agent_1",
  createdByMemberId: "human_1",
};

describe("DeployManager (#73 — deploy/redeploy/rollback/health/scale, all mocked)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("deploys to a live https URL and posts it to the channel", async () => {
    const dep = await h.manager.deploy(REQ);
    expect(dep.status).toBe("ready");
    expect(dep.url).toMatch(/^https:\/\/.+/);
    expect(h.posts.some((b) => b.includes(dep.url!))).toBe(true);
    // status + log events were published
    expect(h.events.some((e) => e.type === "deploy_status" && e.status === "ready")).toBe(true);
    expect(h.events.some((e) => e.type === "deploy_log")).toBe(true);
  });

  it("never lets a secret value appear in any log event, the persisted log tail, or the message", async () => {
    const dep = await h.manager.deploy(REQ);
    const logEvents = h.events.filter((e): e is DeployLogEvent => e.type === "deploy_log");
    expect(logEvents.length).toBeGreaterThan(0);
    for (const e of logEvents) expect(e.chunk).not.toContain(SECRET);
    expect(dep.logs.join("\n")).not.toContain(SECRET);
    expect(dep.logs.join("\n")).toContain("‹redacted›"); // the secret WAS echoed, then masked
    for (const body of h.posts) expect(body).not.toContain(SECRET);
  });

  it("redacts a secret from a provider error too", async () => {
    h.provider.failNext = `boom near ${SECRET}`;
    const dep = await h.manager.deploy(REQ);
    expect(dep.status).toBe("error");
    expect(dep.error).not.toContain(SECRET);
  });

  it("redeploy creates a new immutable deployment (history grows; ids differ)", async () => {
    const first = await h.manager.deploy(REQ);
    const second = await h.manager.deploy({ ...REQ, reason: "push" });
    expect(second.id).not.toBe(first.id);
    const history = await h.manager.list(REQ.sessionId, REQ.channelId);
    expect(history.length).toBe(2);
  });

  it("rollback re-promotes the prior good deployment", async () => {
    const first = await h.manager.deploy(REQ);
    await h.manager.deploy({ ...REQ, reason: "push" }); // current live
    const rolled = await h.manager.rollback(REQ);
    expect(rolled.status).toBe("rolled_back");
    expect(rolled.url).toBe(first.url); // restored the first deployment's URL
    expect(rolled.rolledBackFromId).toBe(first.id);
  });

  it("rollback with no prior good deployment throws", async () => {
    await h.manager.deploy(REQ); // only one ready deployment → nothing to roll back to
    await expect(h.manager.rollback(REQ)).rejects.toBeInstanceOf(NoRollbackTargetError);
  });

  it("auto-restarts an unhealthy deployment and recovers", async () => {
    const dep = await h.manager.deploy(REQ);
    h.provider.unhealthy = true; // it goes down...
    const checked = await h.manager.checkHealth(dep);
    expect(h.provider.restarted).toContain(dep.providerDeploymentId);
    expect(checked.status).toBe("ready"); // ...restart brought it back
  });

  it("reports an unhealthy deployment that a restart cannot fix", async () => {
    const dep = await h.manager.deploy(REQ);
    h.provider.unhealthy = true;
    h.provider.restartRecovers = false; // restart does not fix it
    const checked = await h.manager.checkHealth(dep);
    expect(checked.status).toBe("unhealthy");
    expect(h.posts.some((b) => /unhealthy/i.test(b))).toBe(true);
  });

  it("refuses to deploy under data-privacy mode (off-platform egress gate)", async () => {
    const priv = makeHarness({ dataPrivacyMode: true });
    await expect(priv.manager.deploy(REQ)).rejects.toBeInstanceOf(DeployEgressBlocked);
    expect(priv.provider.deployed.length).toBe(0); // never called the provider
  });

  it("throws when the deployment configured no deploy section (opt-in)", async () => {
    const none = makeHarness({ deploy: undefined });
    await expect(none.manager.deploy(REQ)).rejects.toBeInstanceOf(NoDeployConfigError);
  });

  it("clamps scale to the configured maxInstances", async () => {
    const bounded = makeHarness({ deploy: { provider: "dryrun", maxInstances: 3 } });
    const dep = await bounded.manager.deploy(REQ);
    await bounded.manager.scale(dep, { instances: 99 });
    expect(bounded.provider.scaled[0]?.scale.instances).toBe(3);
  });
});
