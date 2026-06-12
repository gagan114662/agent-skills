import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LocalRuntime } from "./local.js";
import { harnessSpec } from "./harness.js";
import type { AgentJob, AgentRuntime } from "./types.js";

/**
 * Post-deploy demo-harness smoke (#166 follow-up). Launches ONE real `demo` harness session end-to-end
 * through the runtime and verifies it completes. The demo harness spawns `bash scripts/agent-harness-demo.sh`,
 * so this exercises the EXACT spawn path a missing `bash` breaks: a spawn error settles `exitCode=null`
 * → `ok=false`. No DB, no model spend, deterministic (the demo script just echoes + exits 0).
 *
 * Wired as the Fly `[deploy] release_command`, a non-zero exit aborts the rollout — so a bash-less (or
 * otherwise un-spawnable) image can never reach production. Pure-ish + injectable: tests pass a fake
 * runtime to assert the pass/fail decision without spawning anything.
 */
export interface SmokeResult {
  ok: boolean;
  /** Human-readable, secret-free outcome line. */
  reason: string;
  /** The terminal {@link RuntimeResult.status}, or null if the session never settled. */
  status: string | null;
  exitCode: number | null;
  sawMarker: boolean;
}

/** The marker the demo harness prints on success (`scripts/agent-harness-demo.sh`). */
export const DONE_MARKER = "agent: done";

export interface SmokeDeps {
  /** Injectable runtime (tests pass a fake); defaults to the real {@link LocalRuntime}. */
  runtime?: AgentRuntime;
  /** Working dir for the demo harness; defaults to the apps/server root so the script path resolves. */
  cwd?: string;
  /** Task text fed to the harness via AGENT_TASK. */
  task?: string;
  /** Wall-clock guard so a hung spawn fails the smoke instead of blocking the deploy forever. */
  timeoutMs?: number;
}

/** The apps/server root — so `scripts/agent-harness-demo.sh` resolves regardless of invocation cwd. */
export function serverRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function runDemoSmoke(deps: SmokeDeps = {}): Promise<SmokeResult> {
  const runtime: AgentRuntime = deps.runtime ?? new LocalRuntime();
  const spec = harnessSpec("demo");
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const job: AgentJob = {
    sessionId: "smoke-demo",
    workspaceId: "smoke",
    command: spec.command,
    args: spec.args,
    env: { AGENT_TASK: deps.task ?? "post-deploy smoke: prove the harness can spawn and complete" },
    cwd: deps.cwd ?? serverRoot(),
    secrets: {},
    caps: { wallClockMs: timeoutMs, idleMs: timeoutMs },
  };

  let output = "";
  let session;
  try {
    session = await runtime.start(job, { onOutput: (_s, chunk) => (output += chunk) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `runtime.start threw: ${msg}`, status: null, exitCode: null, sawMarker: false };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
    timer.unref?.();
  });
  const res = await Promise.race([session.wait(), timeout]);
  if (timer) clearTimeout(timer);

  if (res === "timeout") {
    await session.cancel("timeout").catch(() => undefined);
    return {
      ok: false,
      reason: `demo session did not finish within ${timeoutMs}ms`,
      status: "timeout",
      exitCode: null,
      sawMarker: output.includes(DONE_MARKER),
    };
  }

  const sawMarker = output.includes(DONE_MARKER);
  const ok = res.exitCode === 0 && sawMarker;
  const reason = ok
    ? "demo-harness session completed end-to-end (exit 0, emitted expected output)"
    : res.exitCode === null
      ? "demo session failed to spawn (exitCode=null — is 'bash' installed in the image?)"
      : `demo session ended status=${res.status} exit=${res.exitCode} sawOutput=${sawMarker}`;
  return { ok, reason, status: res.status, exitCode: res.exitCode, sawMarker };
}
