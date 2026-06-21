/**
 * #420 spike: ipop's agent runtime ported onto mattpocock/sandcastle (`@ai-hero/sandcastle`).
 *
 * Goal: "all ipop agents run in this sandbox." Sandcastle orchestrates a coding agent inside an isolated
 * sandbox (Docker/Podman locally, a Vercel Firecracker microVM in prod) with a single `run()` call. This
 * file is the IDIOMATIC sandcastle integration — coded the way the README/walkthrough show — wrapped so it
 * satisfies ipop's existing `AgentRuntime` seam (the same interface `LocalRuntime`/`SandboxRuntime` implement,
 * in `apps/server/src/runtime/types.ts`). Wiring it into the factory behind `AGENT_RUNTIME=sandcastle` is the
 * one-line change documented in ADR-0420; this pilot is build/lint-isolated (outside the pnpm workspace) and
 * NOT wired to prod, so the live fleet is untouched until the ADR's go/no-go.
 *
 * Why an adapter and not a rewrite: ipop already owns admission (#71), the #13 approval gate, the disposition
 * read (#319), and the channel stream. Sandcastle replaces only the innermost step — HOW the harness runs and
 * WHERE — so the smallest correct surface is to make sandcastle look like one more `AgentRuntime`.
 */
import { run, type RunResult } from "@ai-hero/sandcastle";
import { claudeCode } from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

// --- ipop's AgentRuntime seam, mirrored locally so the pilot typechecks in isolation -------------------
// (The live definitions are apps/server/src/runtime/types.ts; the parity test asserts this stays in shape.)

type SessionStatus = "completed" | "failed" | "timeout" | "idle_reaped" | "canceled";
type TerminalReason = "completed" | "failed" | "timeout" | "idle" | "canceled";
type OutputStream = "stdout" | "stderr";

interface ResourceCaps {
  idleMs: number;
  wallClockMs: number;
}
interface AgentJob {
  sessionId: string;
  workspaceId: string;
  /** Resume a prior sandcastle session by id (#82 resume → sandcastle `resumeSession`). */
  snapshotId?: string;
  /** The trusted harness command + args (ipop builds `claude …`); sandcastle owns the invocation, so we
   *  carry only the bits sandcastle needs — the model + the task — and let it spawn the agent. */
  command: string;
  args: string[];
  /** Non-secret env. The task/prompt rides here as `AGENT_TASK` (data, never a command). */
  env: Record<string, string>;
  cwd?: string;
  /** Per-tenant secrets injected at provision time — NEVER written to a snapshot, NEVER logged, resolved
   *  from the #192 vault per session. The workspace's own Claude token lives here. */
  secrets: Record<string, string>;
  region?: string;
  egress?: string[];
  caps: ResourceCaps;
}
interface RuntimeHooks {
  onOutput(stream: OutputStream, chunk: string): void;
}
interface RuntimeResult {
  status: SessionStatus;
  exitCode: number | null;
  snapshotId?: string;
}
interface RunningSession {
  readonly sessionId: string;
  readonly sandboxId?: string;
  wait(): Promise<RuntimeResult>;
  cancel(reason: TerminalReason): Promise<void>;
  steer?(text: string): Promise<void>;
}
interface AgentRuntime {
  readonly kind: "sandcastle";
  start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession>;
}

// --- the managed model (ipop never lets a user pick one — see "remove model picker") -------------------
const MANAGED_MODEL = "claude-opus-4-8";

/**
 * Choose the sandbox provider. Prod = Vercel Firecracker microVM (the same `@vercel/sandbox` ipop already
 * depends on; Docker-in-Docker is unavailable on Fly, see ADR-0420 §Risks). Local/dev = Docker. The provider
 * env is kept disjoint from the agent env on purpose — sandcastle THROWS if they share a key, which is a
 * useful guard against leaking the tenant token into the sandbox layer.
 */
function pickSandbox(job: AgentJob) {
  if (job.region || process.env.SANDCASTLE_PROVIDER === "vercel") {
    return vercel({
      token: process.env.VERCEL_TOKEN,
      projectId: process.env.VERCEL_PROJECT_ID,
      // NB: no tenant secret here — that goes to the AGENT, below.
      env: { RELOAD_REGION: job.region ?? "" },
    });
  }
  return docker({ imageName: process.env.SANDCASTLE_IMAGE ?? "sandcastle:local" });
}

/**
 * SandcastleRuntime — an ipop {@link AgentRuntime} backed by sandcastle. `start()` kicks off `sandcastle.run`
 * and hands back a {@link RunningSession} whose `wait()` resolves at teardown and whose `cancel()` aborts the
 * run (the idle/wall-clock reaper + the #469 in-channel Stop both route here). Streaming is mapped from
 * sandcastle's `onAgentStreamEvent` to ipop's `hooks.onOutput`, so the channel feed stays live.
 */
export class SandcastleRuntime implements AgentRuntime {
  readonly kind = "sandcastle" as const;

  async start(job: AgentJob, hooks: RuntimeHooks): Promise<RunningSession> {
    const controller = new AbortController();
    const task = job.env.AGENT_TASK ?? "";

    // Coded like the README: pick an agent, pick a sandbox, hand it a prompt. The tenant's OWN Claude token
    // is passed via the agent provider's `env` (highest-priority resolution) so the credential reaches the
    // harness but is never written to source, a snapshot, or the sandbox layer. `bypassPermissions` because
    // ipop's #13 human gate lives OUTSIDE the harness (the agent drafts; ipop gates the irreversible action),
    // so an in-harness permission prompt would only deadlock a non-interactive run.
    const pending: Promise<RunResult> = run({
      agent: claudeCode(MANAGED_MODEL, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: job.secrets.CLAUDE_CODE_OAUTH_TOKEN ?? "" },
        permissionMode: "bypassPermissions",
        captureSessions: true,
      }),
      sandbox: pickSandbox(job),
      prompt: task,
      // ipop's caps drive sandcastle's own timeouts so the two reapers agree instead of fighting.
      idleTimeoutSeconds: Math.max(1, Math.round(job.caps.idleMs / 1000)),
      // Resume a retained sandcastle session when ipop is waking a snapshot (#82).
      resumeSession: job.snapshotId,
      // Cancellation: ipop's cancel()/reaper aborts this signal, ending the run.
      signal: controller.signal,
      // Stream every agent event back into the ipop channel feed (text → a line; tool calls → a marker).
      logging: {
        type: "file",
        path: `.sandcastle/logs/${job.sessionId}.log`,
        onAgentStreamEvent: (event) => {
          if (event.type === "text" || event.type === "raw") {
            hooks.onOutput("stdout", String((event as { text?: string }).text ?? ""));
          } else if (event.type === "toolCall") {
            hooks.onOutput("stdout", `\u{1F527} ${(event as { name?: string }).name ?? "tool"}`);
          }
        },
      },
    });

    // Never reject out of wait(): a thrown run maps to `failed` exactly like the bespoke runtime, so the
    // SessionManager's teardown (release admission slot, finalize the row, route to self-healing) is identical.
    const done: Promise<RuntimeResult> = pending.then(
      (result): RuntimeResult => ({
        status: "completed",
        exitCode: 0,
        // sandcastle returns the resumable session id on the first iteration — keep it as ipop's snapshotId.
        snapshotId: result.iterations[0]?.sessionId,
      }),
      (): RuntimeResult => ({ status: "failed", exitCode: null }),
    );

    return {
      sessionId: job.sessionId,
      wait: () => done,
      async cancel(reason: TerminalReason) {
        // Map ipop's terminal reasons onto an abort; sandcastle ends the run and the `done` promise settles.
        void reason;
        controller.abort();
      },
      // Steering (#53) is a documented follow-up: sandcastle drives the harness, so a steer line would need
      // its interactive() API. Omitted here ⇒ SessionManager.steer honestly reports "not delivered".
    };
  }
}
