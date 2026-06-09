import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import type {
  ChannelPoster,
  SessionLogger,
  SessionStore,
} from "../../src/runtime/manager.js";
import type { StaticSecretsResolver } from "../../src/runtime/secrets-resolver.js";
import { StaticSecretsResolver as Secrets } from "../../src/runtime/secrets-resolver.js";
import type {
  AgentJob,
  AgentRuntime,
  RunningSession,
  RuntimeHooks,
  RuntimeResult,
  TerminalReason,
} from "../../src/runtime/types.js";
import { statusForReason } from "../../src/runtime/types.js";
import type { AgentSession, ResourceCaps, SessionStatus } from "../../src/db/repositories/agent-sessions.js";

// --- fakes ------------------------------------------------------------------

interface PostedMessage {
  body: string;
  parentMessageId?: string;
}

class FakeStore implements SessionStore {
  created?: AgentSession;
  running = false;
  finalized?: { status: SessionStatus; exitCode?: number | null; result?: string | null };
  private seq = 0;

  create(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    runtime: "local" | "sandbox";
    command: string;
    caps: ResourceCaps;
  }): Promise<AgentSession> {
    this.created = {
      id: "sess_test",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      agentMemberId: input.agentMemberId,
      createdByMemberId: input.createdByMemberId,
      runtime: input.runtime,
      status: "provisioning",
      command: input.command,
      sandboxId: null,
      snapshotId: null,
      exitCode: null,
      result: null,
      caps: input.caps,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(0),
    };
    return Promise.resolve(this.created);
  }
  markRunning(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }
  finalize(
    _id: string,
    fields: { status: SessionStatus; exitCode?: number | null; result?: string | null },
  ): Promise<void> {
    this.finalized = fields;
    return Promise.resolve();
  }
  // unique id helper for posts
  nextId(): string {
    this.seq += 1;
    return `msg_${this.seq}`;
  }
}

class FakePoster implements ChannelPoster {
  readonly posts: PostedMessage[] = [];
  constructor(private readonly store: FakeStore) {}
  post(input: { body: string; parentMessageId?: string }): Promise<{ id: string }> {
    this.posts.push({ body: input.body, parentMessageId: input.parentMessageId });
    return Promise.resolve({ id: this.store.nextId() });
  }
  bodies(): string[] {
    return this.posts.map((p) => p.body);
  }
}

const silentLogger: SessionLogger = {
  child: () => silentLogger,
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A runtime that emits fixed output synchronously and then completes with `exitCode`. */
class CompletingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  constructor(
    private readonly chunks: string[],
    private readonly exitCode: number,
  ) {}
  start(_job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    for (const c of this.chunks) hooks.onOutput("stdout", c);
    const exitCode = this.exitCode;
    const session: RunningSession = {
      sessionId: _job.sessionId,
      wait: () =>
        Promise.resolve<RuntimeResult>({
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
        }),
      cancel: () => Promise.resolve(),
    };
    return Promise.resolve(session);
  }
}

/** Captures the job it is started with (for asserting env/cwd threading), then completes. */
class CapturingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  job?: AgentJob;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    this.job = job;
    hooks.onOutput("stdout", "review done\n");
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "completed", exitCode: 0 }),
      cancel: () => Promise.resolve(),
    });
  }
}

/** A runtime that never produces output and only ends when cancelled (drives reaper tests). */
class PendingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  start(job: AgentJob): Promise<RunningSession> {
    let resolve!: (r: RuntimeResult) => void;
    const done = new Promise<RuntimeResult>((r) => (resolve = r));
    const session: RunningSession = {
      sessionId: job.sessionId,
      wait: () => done,
      cancel: (reason: TerminalReason) => {
        resolve({ status: statusForReason(reason), exitCode: null });
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

const caps = (over: Partial<ResourceCaps> = {}): ResourceCaps => ({
  wallClockMs: 10_000,
  idleMs: 10_000,
  ...over,
});

function makeManager(runtime: AgentRuntime, c: ResourceCaps, secrets: StaticSecretsResolver) {
  const store = new FakeStore();
  const poster = new FakePoster(store);
  const manager = new SessionManager({
    runtime,
    store,
    poster,
    secrets,
    harness: { command: "bash", args: ["x.sh"] },
    caps: c,
    logger: silentLogger,
  });
  return { manager, store, poster };
}

const launch = {
  workspaceId: "ws_1",
  channelId: "ch_1",
  agentMemberId: "mem_agent",
  createdByMemberId: "mem_human",
  task: "do the thing",
};

// --- tests ------------------------------------------------------------------

describe("SessionManager (#25 — server-owned run, streaming, reaper, redaction)", () => {
  it("streams output line-by-line into the channel and finalizes completed", async () => {
    const runtime = new CompletingRuntime(["line one\nline two\n"], 0);
    const { manager, store, poster } = makeManager(runtime, caps(), new Secrets({}));

    const session = await manager.launch(launch);
    await manager.join(session.id);

    const bodies = poster.bodies();
    expect(bodies[0]).toContain("started"); // parent message
    expect(bodies).toContain("line one");
    expect(bodies).toContain("line two");
    expect(bodies.at(-1)).toContain("completed"); // terminal message
    // streamed lines thread under the start message
    expect(poster.posts[1]?.parentMessageId).toBe("msg_1");
    expect(store.finalized?.status).toBe("completed");
    expect(store.finalized?.result).toContain("line one");
  });

  it("redacts secret values from streamed output and the persisted result", async () => {
    const runtime = new CompletingRuntime(["token=sk-supersecret-value-123\n"], 0);
    const { manager, store, poster } = makeManager(
      runtime,
      caps(),
      new Secrets({ MY_SECRET: "sk-supersecret-value-123" }),
    );

    const session = await manager.launch(launch);
    await manager.join(session.id);

    const all = poster.bodies().join("\n") + (store.finalized?.result ?? "");
    expect(all).not.toContain("sk-supersecret-value-123");
    expect(poster.bodies().some((b) => b.includes("token=‹redacted›"))).toBe(true);
  });

  it("idle-reaps a silent session to idle_reaped", async () => {
    const { manager, store } = makeManager(new PendingRuntime(), caps({ idleMs: 40 }), new Secrets({}));
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(store.finalized?.status).toBe("idle_reaped");
    expect(manager.activeCount).toBe(0); // reaped — nothing left running
  });

  it("wall-clock-reaps a long session to timeout", async () => {
    const { manager, store } = makeManager(
      new PendingRuntime(),
      caps({ wallClockMs: 40, idleMs: 10_000 }),
      new Secrets({}),
    );
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(store.finalized?.status).toBe("timeout");
  });

  it("threads all posts under an invoking message when parentMessageId is given (#59)", async () => {
    const runtime = new CompletingRuntime(["line one\n"], 0);
    const { manager, poster } = makeManager(runtime, caps(), new Secrets({}));

    const session = await manager.launch({ ...launch, parentMessageId: "msg_invoke" });
    await manager.join(session.id);

    // The started message AND the streamed line thread under the invoking message, not a new root.
    expect(poster.posts[0]?.parentMessageId).toBe("msg_invoke");
    expect(poster.posts.find((p) => p.body === "line one")?.parentMessageId).toBe("msg_invoke");
  });

  it("merges persona harnessEnv into the job env alongside AGENT_TASK (#59)", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager(runtime, caps(), new Secrets({}));

    const session = await manager.launch({
      ...launch,
      harnessEnv: { AGENT_APPEND_SYSTEM_PROMPT: "You review code.", AGENT_ALLOWED_TOOLS: "Read,Grep" },
    });
    await manager.join(session.id);

    expect(runtime.job?.env.AGENT_TASK).toBe("do the thing");
    expect(runtime.job?.env.AGENT_APPEND_SYSTEM_PROMPT).toBe("You review code.");
    expect(runtime.job?.env.AGENT_ALLOWED_TOOLS).toBe("Read,Grep");
  });

  it("leaves the job env as AGENT_TASK-only when no harnessEnv is given (unchanged)", async () => {
    const runtime = new CapturingRuntime();
    const { manager } = makeManager(runtime, caps(), new Secrets({}));
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(Object.keys(runtime.job?.env ?? {})).toEqual(["AGENT_TASK"]);
  });

  it("cancel() ends a running session", async () => {
    const { manager, store } = makeManager(new PendingRuntime(), caps(), new Secrets({}));
    const session = await manager.launch(launch);
    // let drive() reach the running state
    await new Promise((r) => setTimeout(r, 10));
    expect(await manager.cancel(session.id)).toBe(true);
    await manager.join(session.id);
    expect(store.finalized?.status).toBe("canceled");
    // cancelling an unknown / already-finished session is a no-op
    expect(await manager.cancel(session.id)).toBe(false);
  });
});
