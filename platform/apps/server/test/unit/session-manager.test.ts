import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/runtime/manager.js";
import { harnessLineDecoder } from "../../src/runtime/stream-json.js";
import type { LineDecoder } from "../../src/runtime/stream-json.js";
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
import { REDACTION_MASK } from "../../src/runtime/redact.js";

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
    harness?: string | null;
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
      harness: (input.harness ?? null) as AgentSession["harness"],
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
  // #248: race-safe terminal write — only finalizes a row that has not already gone terminal.
  forced?: { status: SessionStatus; result?: string | null; exitCode?: number | null };
  forceFinalize(
    _id: string,
    fields: { status: SessionStatus; result?: string | null; exitCode?: number | null },
  ): Promise<boolean> {
    if (this.finalized) return Promise.resolve(false);
    this.finalized = fields;
    this.forced = fields;
    return Promise.resolve(true);
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

/**
 * A poster whose post() promises resolve OUT of emission order (earlier calls resolve later). If the
 * manager fires streamed posts concurrently (fire-and-forget), they land reversed and the terminal
 * message can interleave; if it serializes them, they land in emission order with the terminal last.
 * Records bodies in the order their post() promise RESOLVED.
 */
class ReorderingPoster implements ChannelPoster {
  readonly completed: string[] = [];
  private call = 0;
  constructor(private readonly store: FakeStore) {}
  post(input: { body: string }): Promise<{ id: string }> {
    const idx = this.call++;
    const delay = (20 - idx) * 2; // earlier calls → larger delay → resolve later if run concurrently
    return new Promise((resolve) => {
      setTimeout(() => {
        this.completed.push(input.body);
        resolve({ id: this.store.nextId() });
      }, Math.max(1, delay));
    });
  }
}

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

/** A pending runtime whose session supports steering — records the guidance it receives (#53). */
class SteerablePendingRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  readonly steered: string[] = [];
  start(job: AgentJob): Promise<RunningSession> {
    let resolve!: (r: RuntimeResult) => void;
    const done = new Promise<RuntimeResult>((r) => (resolve = r));
    const steered = this.steered;
    const session: RunningSession = {
      sessionId: job.sessionId,
      wait: () => done,
      cancel: (reason: TerminalReason) => {
        resolve({ status: statusForReason(reason), exitCode: null });
        return Promise.resolve();
      },
      steer: (text: string) => {
        steered.push(text);
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

function makeManager(
  runtime: AgentRuntime,
  c: ResourceCaps,
  secrets: StaticSecretsResolver,
  decodeOutput?: LineDecoder,
) {
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
    decodeOutput,
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

  it("redacts pasted secrets from task text before model context or visible posts (#671)", async () => {
    const runtime = new CapturingRuntime();
    const { manager, poster } = makeManager(runtime, caps(), new Secrets({}));
    const rawSecret = "sk-live-taskSecret12345";

    const session = await manager.launch({
      ...launch,
      task: "Use OPENAI_API_KEY=" + rawSecret + " to do the thing",
      harnessEnv: { AGENT_APPEND_SYSTEM_PROMPT: "never echo " + rawSecret },
    });
    await manager.join(session.id);

    expect(runtime.job?.env.AGENT_TASK).not.toContain(rawSecret);
    expect(runtime.job?.env.AGENT_APPEND_SYSTEM_PROMPT).not.toContain(rawSecret);
    expect(poster.bodies().join("\n")).not.toContain(rawSecret);
    expect(runtime.job?.env.AGENT_TASK).toContain(REDACTION_MASK);
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

  it("decodes claude-code stream-json into readable channel text and surfaces tool calls (#81)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Investigating the failure." }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "All tests pass." }),
    ].join("\n") + "\n";
    const runtime = new CompletingRuntime([events], 0);
    const { manager, poster } = makeManager(runtime, caps(), new Secrets({}), harnessLineDecoder("claude-code"));

    const session = await manager.launch(launch);
    await manager.join(session.id);

    const bodies = poster.bodies();
    // Readable assistant text + result summary reach the channel.
    expect(bodies).toContain("Investigating the failure.");
    expect(bodies).toContain("All tests pass.");
    // The tool call is surfaced as a readable line.
    expect(bodies.some((b) => b.includes("🔧") && b.includes("Bash") && b.includes("pnpm test"))).toBe(true);
    // No raw JSON event blob is ever posted to the channel.
    expect(bodies.some((b) => b.includes('"type":"assistant"'))).toBe(false);
    // The init event is suppressed (no model-config blob in the channel).
    expect(bodies.some((b) => b.includes('"subtype":"init"'))).toBe(false);
  });

  it("leaves demo harness output unchanged when a demo decoder is wired (#81 regression)", async () => {
    // A JSON-looking line from the demo harness must stream verbatim — never decoded.
    const jsonish = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const runtime = new CompletingRuntime([`build complete\n${jsonish}\n`], 0);
    const { manager, poster } = makeManager(runtime, caps(), new Secrets({}), harnessLineDecoder("demo"));

    const session = await manager.launch(launch);
    await manager.join(session.id);

    const bodies = poster.bodies();
    expect(bodies).toContain("build complete");
    expect(bodies).toContain(jsonish); // verbatim, not decoded
  });

  it("redacts secrets from decoded claude-code channel output (#81)", async () => {
    const secret = "sk-supersecret-value-123";
    const line =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `using token ${secret} to authenticate` }] },
      }) + "\n";
    const runtime = new CompletingRuntime([line], 0);
    const { manager, store, poster } = makeManager(
      runtime,
      caps(),
      new Secrets({ MY_SECRET: secret }),
      harnessLineDecoder("claude-code"),
    );

    const session = await manager.launch(launch);
    await manager.join(session.id);

    const all = poster.bodies().join("\n") + (store.finalized?.result ?? "");
    expect(all).not.toContain(secret);
    expect(poster.bodies().some((b) => b.includes("‹redacted›"))).toBe(true);
  });

  it("persists streamed lines in emission order and flushes them before the terminal message", async () => {
    // Regression: streamed posts were fire-and-forget, so they raced the terminal message + finalize —
    // a consumer reading after completion saw lines out of order or missing entirely.
    const runtime = new CompletingRuntime(["alpha\nbeta\ngamma\n"], 0);
    const store = new FakeStore();
    const poster = new ReorderingPoster(store);
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
    });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    // All streamed lines are persisted by the time the run completes...
    expect(poster.completed).toContain("alpha");
    expect(poster.completed).toContain("beta");
    expect(poster.completed).toContain("gamma");
    // ...in emission order (not reversed by concurrent resolution)...
    const streamed = poster.completed.filter((b) => ["alpha", "beta", "gamma"].includes(b));
    expect(streamed).toEqual(["alpha", "beta", "gamma"]);
    // ...and the terminal "completed" message lands after every streamed line.
    const termIdx = poster.completed.findIndex((b) => b.includes("completed"));
    expect(termIdx).toBeGreaterThan(poster.completed.indexOf("gamma"));
  });

  it("cancel() ends a running session", async () => {
    const { manager, store } = makeManager(new PendingRuntime(), caps(), new Secrets({}));
    const session = await manager.launch(launch);
    // let drive() reach the running state
    await new Promise((r) => setTimeout(r, 10));
    expect(await manager.cancel(session.id)).toBe(true);
    // The terminal row is written BEFORE cancel() resolves — no join() needed — so a UI that polls
    // right after Stop never still sees `running` (gemini #249 race-fix: cancel awaits the run promise).
    expect(store.finalized?.status).toBe("canceled");
    await manager.join(session.id);
    expect(store.finalized?.status).toBe("canceled");
    // cancelling an unknown / already-finished session is a no-op
    expect(await manager.cancel(session.id)).toBe(false);
  });

  it("steer() delivers guidance to a live, steerable session (#53)", async () => {
    const runtime = new SteerablePendingRuntime();
    const { manager } = makeManager(runtime, caps(), new Secrets({}));
    const session = await manager.launch(launch);
    await new Promise((r) => setTimeout(r, 10)); // let drive() reach the running state

    expect(await manager.steer(session.id, "focus on the tests")).toBe(true);
    expect(runtime.steered).toEqual(["focus on the tests"]);

    await manager.cancel(session.id);
    await manager.join(session.id);
  });

  it("steer() returns false for an unknown session or a runtime without steering (#53)", async () => {
    // unknown id → not delivered
    const { manager: m1 } = makeManager(new SteerablePendingRuntime(), caps(), new Secrets({}));
    expect(await m1.steer("nope", "x")).toBe(false);

    // a live session whose runtime has no steer support → not delivered (no throw)
    const { manager: m2 } = makeManager(new PendingRuntime(), caps(), new Secrets({}));
    const s = await m2.launch(launch);
    await new Promise((r) => setTimeout(r, 10));
    expect(await m2.steer(s.id, "x")).toBe(false);
    await m2.cancel(s.id);
    await m2.join(s.id);
  });
});

// --- per-session harness selection (#50) ------------------------------------

/**
 * Build a manager wired with a default harness kind + an override resolver, mirroring the production
 * `default.ts` seam. The resolver maps each kind to a distinct spec + decoder so a test can assert
 * the manager honored the per-session override (spec passed to the runtime, decoder used, kind
 * persisted) — identically regardless of the runtime backend, which only ever sees command/args/env.
 */
function makeSelectableManager(runtime: AgentRuntime) {
  const store = new FakeStore();
  const poster = new FakePoster(store);
  const manager = new SessionManager({
    runtime,
    store,
    poster,
    secrets: new Secrets({}),
    // The env default is claude-code; per-session launches may override it.
    harness: { command: "claude-bin", args: ["--default"] },
    harnessKind: "claude-code",
    decodeOutput: harnessLineDecoder("claude-code"),
    harnessOverrides: (kind) => {
      const specs: Record<string, { command: string; args: string[] }> = {
        demo: { command: "bash", args: ["scripts/agent-harness-demo.sh"] },
        "claude-code": { command: "claude-bin", args: ["--default"] },
        codex: { command: "bash", args: ["-lc", "'codex' exec \"$AGENT_TASK\" --json --full-auto"] },
      };
      return { ...specs[kind], decode: harnessLineDecoder(kind as Parameters<typeof harnessLineDecoder>[0]) };
    },
    caps: caps(),
    logger: silentLogger,
  });
  return { manager, store, poster };
}

describe("SessionManager — per-session harness selection (#50)", () => {
  it("runs the env-default harness and persists its kind when no override is given", async () => {
    const runtime = new CapturingRuntime();
    const { manager, store } = makeSelectableManager(runtime);
    const session = await manager.launch(launch);
    await manager.join(session.id);
    // The runtime got the default (claude-code) spec, and the row records the default kind.
    expect(runtime.job?.command).toBe("claude-bin");
    expect(runtime.job?.args).toEqual(["--default"]);
    expect(store.created?.harness).toBe("claude-code");
  });

  it("honors a per-session codex override: codex spec to the runtime + persisted on the row", async () => {
    const runtime = new CapturingRuntime();
    const { manager, store } = makeSelectableManager(runtime);
    const session = await manager.launch({ ...launch, harness: "codex" });
    await manager.join(session.id);
    // Switching claude-code → codex per session reaches the runtime identically (it only sees the
    // resolved command/args), and the chosen kind is persisted for audit.
    expect(runtime.job?.command).toBe("bash");
    expect(runtime.job?.args?.[0]).toBe("-lc");
    expect(runtime.job?.args?.[1]).toContain("'codex' exec \"$AGENT_TASK\"");
    expect(store.created?.harness).toBe("codex");
    // The command column reflects the codex harness, not the env default.
    expect(store.created?.command).toBe("bash");
  });

  it("uses the codex decoder for a codex-overridden session (readable channel output)", async () => {
    const events =
      [
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Investigating." } }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "pnpm test", exit_code: 0 },
        }),
      ].join("\n") + "\n";
    const runtime = new CompletingRuntime([events], 0);
    const { manager, poster } = makeSelectableManager(runtime);
    const session = await manager.launch({ ...launch, harness: "codex" });
    await manager.join(session.id);
    const bodies = poster.bodies();
    expect(bodies).toContain("Investigating.");
    expect(bodies.some((b) => b.includes("🔧") && b.includes("pnpm test"))).toBe(true);
    // No raw codex JSON blob ever reaches the channel.
    expect(bodies.some((b) => b.includes('"type":"item.completed"'))).toBe(false);
  });

  it("rejects an invalid harness kind before persisting or starting anything", async () => {
    const runtime = new CapturingRuntime();
    const { manager, store } = makeSelectableManager(runtime);
    await expect(
      manager.launch({ ...launch, harness: "gemini" as unknown as "codex" }),
    ).rejects.toThrow();
    // Nothing was persisted and the runtime was never touched.
    expect(store.created).toBeUndefined();
    expect(runtime.job).toBeUndefined();
  });
});

describe("SessionManager — mid-run failure routing (#242)", () => {
  type FailureEvent = Parameters<NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["onSessionFailure"]>>[0];

  function makeRoutingManager(runtime: AgentRuntime, onSessionFailure: (e: FailureEvent) => Promise<void>) {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      harnessKind: "claude-code",
      decodeOutput: harnessLineDecoder("claude-code"),
      caps: caps(),
      logger: silentLogger,
      onSessionFailure,
    });
    return { manager, poster };
  }

  it("routes a model-misconfig (claude-fable-5) as failureClass 'model' with the real error excerpt", async () => {
    // The exact prod stream: claude -p --model claude-fable-5 emits a single is_error result, exit 1.
    const resultEvent =
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result:
          "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
      }) + "\n";
    const runtime = new CompletingRuntime([resultEvent], 1);
    const events: FailureEvent[] = [];
    const { manager, poster } = makeRoutingManager(runtime, async (e) => {
      events.push(e);
    });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(events).toHaveLength(1);
    expect(events[0]!.failureClass).toBe("model");
    expect(events[0]!.exitCode).toBe(1);
    // The surfaced excerpt names the ACTUAL cause (not just "error · exit 1").
    expect(events[0]!.errorExcerpt).toContain("claude-fable-5");
    // The owner-facing terminal message is actionable, not the opaque generic error.
    const terminal = poster.bodies().at(-1)!;
    expect(terminal).toContain("❌");
    expect(terminal).toContain("Settings → Model");
  });

  it("a clean completion never routes a failure (happy path after the model is fixed)", async () => {
    const ok =
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Here's your SEO draft." }) +
      "\n";
    const runtime = new CompletingRuntime([ok], 0);
    const events: FailureEvent[] = [];
    const { manager } = makeRoutingManager(runtime, async (e) => {
      events.push(e);
    });
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(events).toHaveLength(0);
  });
});

// --- #248: tasks reach a TERMINAL surfaced state; robust cancel; no silent vanish -----------------

describe("SessionManager — deliverable surfacing on completion (#248)", () => {
  type CompletedEvent = Parameters<
    NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["onSessionCompleted"]>
  >[0];

  function makeSurfacingManager(
    runtime: AgentRuntime,
    onSessionCompleted: (e: CompletedEvent) => Promise<void>,
  ) {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
      onSessionCompleted,
    });
    return { manager, store };
  }

  it("surfaces a completed session's draft as a deliverable artifact (the 'vanish' fix)", async () => {
    const runtime = new CompletingRuntime(["Here's a draft: 3 tweets ready.\n"], 0);
    const events: CompletedEvent[] = [];
    const { manager } = makeSurfacingManager(runtime, async (e) => {
      events.push(e);
    });
    const session = await manager.launch({ ...launch, task: "draft 3 tweets" });
    await manager.join(session.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(session.id);
    expect(events[0]!.task).toBe("draft 3 tweets");
    expect(events[0]!.result).toContain("3 tweets ready");
  });

  it("does NOT surface a deliverable when the launch opted out (autonomy/watchdog)", async () => {
    const runtime = new CompletingRuntime(["stage output\n"], 0);
    const events: CompletedEvent[] = [];
    const { manager } = makeSurfacingManager(runtime, async (e) => {
      events.push(e);
    });
    const session = await manager.launch({ ...launch, surfaceDeliverable: false });
    await manager.join(session.id);
    expect(events).toHaveLength(0);
  });

  it("does NOT surface a deliverable for a failed session (it routes a failure instead)", async () => {
    const runtime = new CompletingRuntime(["boom\n"], 1);
    const events: CompletedEvent[] = [];
    const { manager } = makeSurfacingManager(runtime, async (e) => {
      events.push(e);
    });
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(events).toHaveLength(0);
  });

  it("does NOT surface a deliverable when the run produced no output", async () => {
    const runtime = new CompletingRuntime([], 0);
    const events: CompletedEvent[] = [];
    const { manager } = makeSurfacingManager(runtime, async (e) => {
      events.push(e);
    });
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(events).toHaveLength(0);
  });
});

describe("SessionManager — a harness-reported error never surfaces a deliverable (#251)", () => {
  type CompletedEvent = Parameters<
    NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["onSessionCompleted"]>
  >[0];
  type FailureEvent = Parameters<
    NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["onSessionFailure"]>
  >[0];

  function makeManager251(runtime: AgentRuntime, secrets: Record<string, string> = {}) {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const completed: CompletedEvent[] = [];
    const failures: FailureEvent[] = [];
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets(secrets),
      harness: { command: "bash", args: ["x.sh"] },
      harnessKind: "claude-code",
      decodeOutput: harnessLineDecoder("claude-code"),
      caps: caps(),
      logger: silentLogger,
      onSessionCompleted: async (e) => {
        completed.push(e);
      },
      onSessionFailure: async (e) => {
        failures.push(e);
      },
    });
    return { manager, store, poster, completed, failures };
  }

  it("an exit-0 run that ends with is_error:true is treated as FAILED — no deliverable card, failure routed", async () => {
    // The prod bug: `claude -p` can exit 0 yet emit a terminal `{type:'result', is_error:true}` ("I'm
    // missing a tool I need"). The PROCESS succeeded; the agent RUN failed with no artifact. Surfacing it
    // as a "deliverable ready for review" card with an Approve button is a lying success.
    const errorResult =
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "I couldn't complete the task — I'm missing a tool I need.",
      }) + "\n";
    const runtime = new CompletingRuntime([errorResult], 0); // exit 0 despite the error result
    const { manager, store, poster, completed, failures } = makeManager251(runtime);

    const session = await manager.launch({ ...launch, task: "draft 3 tweets" });
    await manager.join(session.id);

    // NO deliverable card is surfaced (never an Approve button on a no-artifact run).
    expect(completed).toHaveLength(0);
    // The run is recorded as failed (the board never reports success for a failed run)...
    expect(store.finalized?.status).toBe("failed");
    // ...and routed to the failure sink so it shows Failed-with-reason + retry.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.status).toBe("failed");
    // The terminal channel message is a failure mark, not a green check.
    const terminal = poster.bodies().at(-1)!;
    expect(terminal).toContain("❌");
    expect(terminal).not.toContain("✅");
  });

  it("persists the failed tool name, redacted args, and error in the failure result (#666)", async () => {
    const toolUse =
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_fail",
              name: "Bash",
              input: { command: "pnpm test -- --token sk-live-should-redact-123456" },
            },
          ],
        },
      }) + "\n";
    const errorResult =
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Bash exited 1: test failure",
      }) + "\n";
    const runtime = new CompletingRuntime([toolUse + errorResult], 0);
    const { manager, store } = makeManager251(runtime, { TOOL_TOKEN: "sk-live-should-redact-123456" });

    const session = await manager.launch({ ...launch, task: "run tests" });
    await manager.join(session.id);

    expect(store.finalized?.status).toBe("failed");
    expect(store.finalized?.result).toContain("failed tool: Bash");
    expect(store.finalized?.result).toContain("pnpm test");
    expect(store.finalized?.result).toContain("Bash exited 1: test failure");
    expect(store.finalized?.result).not.toContain("sk-live-should-redact-123456");
  });

  it("an exit-0 run with a clean is_error:false result still surfaces its deliverable (happy path intact)", async () => {
    const ok =
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Here are 3 tweets." }) + "\n";
    const runtime = new CompletingRuntime([ok], 0);
    const { manager, store, completed, failures } = makeManager251(runtime);

    const session = await manager.launch({ ...launch, task: "draft 3 tweets" });
    await manager.join(session.id);

    expect(store.finalized?.status).toBe("completed");
    expect(failures).toHaveLength(0);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.result).toContain("3 tweets");
  });

  it("an exit-0 run that self-reports a startup failure is FAILED — no done/shipped card (#319)", async () => {
    // The #319 board bug: claude BOOTS, can't find a tool, reports it to the user as an ordinary message
    // and exits 0 with a NON-error result (is_error:false). Neither the exit code (0) nor #251 flags it, so
    // it surfaced as a green check + a "5-tweet launch thread" deliverable that auto-routed to Done/shipped —
    // a shipped card for a session that never started. The disposition now believes the agent's own words.
    const startupFailure =
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "I couldn't start up — my runtime is missing a tool I need (spawn).",
      }) + "\n";
    const runtime = new CompletingRuntime([startupFailure], 0); // clean exit despite never booting
    const { manager, store, poster, completed, failures } = makeManager251(runtime);

    const session = await manager.launch({ ...launch, task: "draft a 5-tweet launch thread" });
    await manager.join(session.id);

    // No deliverable card — the board never shows a failed-to-start session as done/shipped.
    expect(completed).toHaveLength(0);
    // The run is recorded as failed, not completed.
    expect(store.finalized?.status).toBe("failed");
    // Routed to the failure sink as a spawn failure (owner sees "couldn't start up", not a green check).
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureClass).toBe("spawn");
    const terminal = poster.bodies().at(-1)!;
    expect(terminal).toContain("❌");
    expect(terminal).not.toContain("✅");
  });

  it("surfaces the agent's FINAL ANSWER as the deliverable — not the narration/tool transcript", async () => {
    // The live bug: cards showed the transcript head — narration ("I'll start by…") or a tool trace
    // ("🔧 Bash …"). The deliverable must be the produced artifact: the terminal success `result` text.
    const transcript =
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "I'll start by reviewing the homepage." }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "SEO findings: add a meta description to /pricing.",
        }),
      ].join("\n") + "\n";
    const runtime = new CompletingRuntime([transcript], 0);
    const { manager, completed } = makeManager251(runtime);

    const session = await manager.launch({ ...launch, task: "audit homepage SEO" });
    await manager.join(session.id);

    expect(completed).toHaveLength(1);
    // The deliverable is the final answer verbatim — no narration, no tool trace.
    expect(completed[0]!.result).toBe("SEO findings: add a meta description to /pricing.");
    expect(completed[0]!.result).not.toContain("I'll start");
    expect(completed[0]!.result).not.toContain("🔧");
  });
});

// --- #393: a completed deliverable is posted as the agent's chat reply -----------------------------

describe("SessionManager — deliverable posted as a chat message (#393)", () => {
  type PostEvent = Parameters<
    NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["postDeliverableMessage"]>
  >[0];

  function makePostingManager(runtime: AgentRuntime) {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const posts: PostEvent[] = [];
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      harnessKind: "claude-code",
      decodeOutput: harnessLineDecoder("claude-code"),
      caps: caps(),
      logger: silentLogger,
      postDeliverableMessage: async (e) => {
        posts.push(e);
      },
    });
    return { manager, store, posts };
  }

  it("posts the deliverable as a message when the run completes done with a real artifact", async () => {
    const ok =
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Here are 3 tweets." }) + "\n";
    const runtime = new CompletingRuntime([ok], 0);
    const { manager, posts } = makePostingManager(runtime);

    const session = await manager.launch({ ...launch, task: "draft 3 tweets" });
    await manager.join(session.id);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.sessionId).toBe(session.id);
    expect(posts[0]!.channelId).toBe("ch_1");
    expect(posts[0]!.agentMemberId).toBe("mem_agent");
    expect(posts[0]!.task).toBe("draft 3 tweets");
    expect(posts[0]!.result).toContain("3 tweets");
  });

  it("does NOT post for a failed (non-done) session", async () => {
    const runtime = new CompletingRuntime(["boom\n"], 1);
    const { manager, posts } = makePostingManager(runtime);
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(posts).toHaveLength(0);
  });

  it("does NOT post when an exit-0 run self-reports a startup failure (#319 disposition not done)", async () => {
    const startupFailure =
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "I couldn't start up — my runtime is missing a tool I need (spawn).",
      }) + "\n";
    const runtime = new CompletingRuntime([startupFailure], 0);
    const { manager, posts } = makePostingManager(runtime);
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(posts).toHaveLength(0);
  });

  it("does NOT post when the run produced no output (completed but not done)", async () => {
    const runtime = new CompletingRuntime([], 0);
    const { manager, posts } = makePostingManager(runtime);
    const session = await manager.launch(launch);
    await manager.join(session.id);
    expect(posts).toHaveLength(0);
  });
});

describe("SessionManager — owner can ALWAYS stop a runaway (#248)", () => {
  it("force-finalizes an orphaned (not-in-memory) session to canceled — kills the stuck Scout", async () => {
    // The 30-min stuck session is orphaned: no child on this process, frozen `running` in the DB.
    const { manager, store } = makeManager(new PendingRuntime(), caps(), new Secrets({}));
    // A session this manager is NOT driving (e.g. left running by a deploy / another machine).
    const canceled = await manager.cancel("orphaned_session_id");
    expect(canceled).toBe(true);
    expect(store.forced?.status).toBe("canceled");
    expect(store.forced?.result).toContain("Canceled by the owner");
  });

  it("returns false when an orphan is already terminal (idempotent, never stomps a row)", async () => {
    const { manager, store } = makeManager(new CompletingRuntime(["done\n"], 0), caps(), new Secrets({}));
    const session = await manager.launch(launch);
    await manager.join(session.id); // row is now terminal (completed)
    // A late cancel must not overwrite the completed row.
    expect(await manager.cancel(session.id)).toBe(false);
    expect(store.finalized?.status).toBe("completed");
  });
});

// --- #436: bounded inline retry for a transient, pre-progress session death --------------------

import { resetMetrics, renderMetrics } from "../../src/observability/metrics.js";

/**
 * A runtime whose first `failuresBeforeSuccess` attempts die WITHOUT output (null exit code — the
 * spawn/null-exit shape), then a final attempt streams output and completes. Records how many times
 * `start()` was called so a test can prove the manager re-attempted (or didn't).
 */
class FlakyNullExitRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  starts = 0;
  constructor(private readonly failuresBeforeSuccess: number) {}
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    const attempt = ++this.starts;
    const fail = attempt <= this.failuresBeforeSuccess;
    if (!fail) hooks.onOutput("stdout", "recovered on retry\n");
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () =>
        Promise.resolve<RuntimeResult>(
          fail ? { status: "failed", exitCode: null } : { status: "completed", exitCode: 0 },
        ),
      cancel: () => Promise.resolve(),
    });
  }
}

/** Streams output and THEN dies with a null exit code — a death the retry must NOT re-run (idempotency). */
class OutputThenDieRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  starts = 0;
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    this.starts++;
    hooks.onOutput("stdout", "partial work: posted a tweet\n"); // a real action may have landed
    return Promise.resolve({
      sessionId: job.sessionId,
      wait: () => Promise.resolve<RuntimeResult>({ status: "failed", exitCode: null }),
      cancel: () => Promise.resolve(),
    });
  }
}

/** A store that counts finalize calls so a test can prove a retried session is finalized EXACTLY once. */
class CountingStore extends FakeStore {
  finalizeCount = 0;
  override finalize(
    id: string,
    fields: { status: SessionStatus; exitCode?: number | null; result?: string | null },
  ): Promise<void> {
    this.finalizeCount++;
    return super.finalize(id, fields);
  }
}

describe("SessionManager — bounded inline retry for a transient pre-progress death (#436)", () => {
  type CompletedEvent = Parameters<
    NonNullable<import("../../src/runtime/manager.js").SessionManagerDeps["onSessionCompleted"]>
  >[0];

  function makeRetryManager(
    runtime: AgentRuntime,
    sessionRetryMaxAttempts: number,
    onSessionCompleted?: (e: CompletedEvent) => Promise<void>,
  ) {
    const store = new CountingStore();
    const poster = new FakePoster(store);
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
      sessionRetryMaxAttempts,
      // Near-instant backoff so the retry lifecycle is exercised without real wall-clock delay.
      sessionRetryBackoff: { baseMs: 1, factor: 1, capMs: 2, maxAttempts: 1 },
      ...(onSessionCompleted ? { onSessionCompleted } : {}),
    });
    return { manager, store, poster };
  }

  it("retries a null-exit death that produced no output, then completes — finalized once", async () => {
    resetMetrics();
    const runtime = new FlakyNullExitRuntime(1); // die once (no output), then succeed
    const { manager, store } = makeRetryManager(runtime, 2);

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.starts).toBe(2); // it re-attempted the dead spawn
    expect(store.finalized?.status).toBe("completed"); // and recovered to a clean completion
    expect(store.finalizeCount).toBe(1); // EXACTLY one terminal write — the retry never double-finalizes
    expect(manager.activeCount).toBe(0); // nothing left running
    // The retry is counted for before/after reliability measurement.
    expect(renderMetrics()).toContain('agent_session_retries_total{runtime="local"} 1');
  });

  it("does NOT retry once output was produced — protects against a duplicated real action (idempotency)", async () => {
    resetMetrics();
    const runtime = new OutputThenDieRuntime();
    const completed: CompletedEvent[] = [];
    const { manager, store } = makeRetryManager(runtime, 3, async (e) => {
      completed.push(e);
    });

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.starts).toBe(1); // the output-bearing attempt is never re-run
    expect(store.finalized?.status).toBe("failed");
    expect(store.finalizeCount).toBe(1);
    expect(completed).toHaveLength(0); // a failed run surfaces no deliverable
    expect(renderMetrics()).not.toContain('agent_session_retries_total{'); // no retry series emitted
  });

  it("is OFF by default: a null-exit death is finalized failed with no re-attempt", async () => {
    resetMetrics();
    const runtime = new FlakyNullExitRuntime(1);
    const { manager, store } = makeRetryManager(runtime, 1); // default OFF

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.starts).toBe(1); // no retry — today's behavior preserved byte-for-byte
    expect(store.finalized?.status).toBe("failed");
    expect(renderMetrics()).not.toContain('agent_session_retries_total{'); // no retry series emitted
  });

  it("gives up after exhausting the attempt budget (bounded — never loops forever)", async () => {
    resetMetrics();
    const runtime = new FlakyNullExitRuntime(5); // always dies within the budget
    const { manager, store } = makeRetryManager(runtime, 3);

    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(runtime.starts).toBe(3); // exactly maxAttempts, then it stops
    expect(store.finalized?.status).toBe("failed");
    expect(store.finalizeCount).toBe(1);
    expect(renderMetrics()).toContain('agent_session_retries_total{runtime="local"} 2'); // 2 retries before giving up
  });
});

/**
 * A runtime that simulates a WEDGED teardown (#394): it never produces output, its `wait()` never
 * resolves, and — crucially — its `cancel()` does NOT resolve `wait()` either (it returns, but the
 * terminal result never lands). This mirrors the prod hang: a sandbox `teardown()` whose cloud
 * `snapshot()`/`stop()` call hangs, so both `wait()` and the reaper's `cancel()` are stuck and the
 * run loop would block on `await running.wait()` forever — the row stays `running` until only the
 * cross-process fleet watchdog reaps it ("the run hung").
 */
class WedgedTeardownRuntime implements AgentRuntime {
  readonly kind = "local" as const;
  cancels: TerminalReason[] = [];
  start(job: AgentJob): Promise<RunningSession> {
    const session: RunningSession = {
      sessionId: job.sessionId,
      // Never resolves — the teardown that would settle it is wedged.
      wait: () => new Promise<RuntimeResult>(() => {}),
      cancel: (reason: TerminalReason) => {
        this.cancels.push(reason);
        // Deliberately does NOT settle wait() — the hung-teardown simulation.
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  }
}

describe("SessionManager — a reaped run never hangs even if teardown wedges (#394)", () => {
  function makeWedgedManager(c: ResourceCaps) {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const runtime = new WedgedTeardownRuntime();
    const manager = new SessionManager({
      runtime,
      store,
      poster,
      secrets: new Secrets({}),
      harness: { command: "bash", args: ["x.sh"] },
      caps: c,
      logger: silentLogger,
      // A tiny grace so the bounded-finalize path is exercised without real wall-clock delay.
      reapGraceMs: 20,
    });
    return { manager, store, runtime };
  }

  it("idle-reaps a wedged session to idle_reaped within the grace window (no infinite hang)", async () => {
    const { manager, store, runtime } = makeWedgedManager(caps({ idleMs: 20, wallClockMs: 10_000 }));
    const session = await manager.launch(launch);
    await manager.join(session.id); // would hang forever before the fix — wait()/cancel() never settle

    expect(store.finalized?.status).toBe("idle_reaped");
    expect(runtime.cancels).toContain("idle"); // the reaper still asked the runtime to tear down
    expect(manager.activeCount).toBe(0); // ticket freed, nothing left running — no leak
  });

  it("wall-clock-reaps a wedged session to timeout within the grace window", async () => {
    const { manager, store, runtime } = makeWedgedManager(caps({ wallClockMs: 20, idleMs: 10_000 }));
    const session = await manager.launch(launch);
    await manager.join(session.id);

    expect(store.finalized?.status).toBe("timeout");
    expect(runtime.cancels).toContain("timeout");
    expect(manager.activeCount).toBe(0);
  });
});

describe("SessionManager — a session NEVER vanishes silently (#248)", () => {
  /** A secrets resolver that throws BEFORE the run starts (the pre-`try` vanish path). */
  const throwingSecrets = {
    resolve: () => Promise.reject(new Error("vault unreachable")),
  } as unknown as StaticSecretsResolver;

  it("finalizes a session that fails BEFORE start as failed + routes the failure", async () => {
    const store = new FakeStore();
    const poster = new FakePoster(store);
    const failures: { failureClass: string; status: string }[] = [];
    const manager = new SessionManager({
      runtime: new CompletingRuntime(["never reached\n"], 0),
      store,
      poster,
      secrets: throwingSecrets,
      harness: { command: "bash", args: ["x.sh"] },
      caps: caps(),
      logger: silentLogger,
      onSessionFailure: async (e) => {
        failures.push({ failureClass: e.failureClass, status: e.status });
      },
    });
    const session = await manager.launch(launch);
    await manager.join(session.id);
    // The row reached a terminal state (no orphaned `provisioning`) and the failure surfaced.
    expect(store.finalized?.status).toBe("failed");
    expect(store.finalized?.result).toContain("session failed before start");
    expect(store.finalized?.result).toContain("vault unreachable");
    expect(failures).toEqual([{ failureClass: "spawn", status: "failed" }]);
  });
});
