import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LocalRuntime } from "./local.js";
import { harnessSpec } from "./harness.js";
import { FileConfigWorkspaceProvisioner, type WorkspaceProvisioner } from "../config/workspace.js";
import type { AgentJob, AgentRuntime } from "./types.js";

/**
 * Post-deploy demo-harness smoke (#166 follow-up; extended for #238). Launches ONE real `demo` harness
 * session end-to-end through the runtime and verifies it completes. The demo harness spawns
 * `bash scripts/agent-harness-demo.sh`, so this exercises the EXACT spawn path a missing `bash` breaks:
 * a spawn error settles `exitCode=null` → `ok=false`. No DB, no model spend, deterministic.
 *
 * #238: it now also runs the session through the #58 {@link FileConfigWorkspaceProvisioner} FIRST — the
 * provisioner `mkdir`s a per-session dir under the configured workspace root, the EXACT step that died
 * with EACCES on every prod session (root-owned `/app`) yet was NEVER exercised by the old smoke (which
 * spawned from a readable server root). A provisioning failure now fails the smoke → aborts the rollout,
 * so a non-writable workspace root can never silently ship again.
 *
 * Wired as the Fly `[deploy] release_command`, a non-zero exit aborts the rollout — so a bash-less,
 * git-less, or un-provisionable image can never reach production. Pure-ish + injectable: tests pass a
 * fake runtime / provisioner to assert the pass/fail decision without spawning or touching disk.
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
  /** Working dir for the demo harness. When omitted, a per-session dir is PROVISIONED (see below). */
  cwd?: string;
  /**
   * The #58 workspace provisioner (#238). When `cwd` is omitted, the smoke provisions a per-session dir
   * through this — exercising the real `mkdir <workspaceRoot>/<id>` that died with EACCES in prod.
   * Defaults to the real {@link FileConfigWorkspaceProvisioner}; tests inject a fake (or pass `cwd`).
   */
  workspace?: WorkspaceProvisioner;
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

  // #238: provision a per-session workspace the SAME way a real session does, so a non-writable
  // workspace root (the prod EACCES) fails the smoke here instead of every user's session. The demo
  // script is referenced by ABSOLUTE path so it still resolves from the provisioned cwd.
  let cwd = deps.cwd;
  if (cwd === undefined) {
    const provisioner = deps.workspace ?? new FileConfigWorkspaceProvisioner();
    try {
      const prepared = await provisioner.prepare({ sessionId: "smoke-demo", workspaceId: "smoke" });
      cwd = prepared.cwd ?? serverRoot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: `workspace provisioning failed (${msg}) — is RELOAD_WORKSPACE_ROOT writable by the runtime user?`,
        status: null,
        exitCode: null,
        sawMarker: false,
      };
    }
  }

  const demoScript = resolve(serverRoot(), "scripts", "agent-harness-demo.sh");
  const job: AgentJob = {
    sessionId: "smoke-demo",
    workspaceId: "smoke",
    command: spec.command, // "bash"
    // Absolute script path: the demo harness runs correctly from the provisioned per-session cwd.
    args: [demoScript],
    env: { AGENT_TASK: deps.task ?? "post-deploy smoke: prove the harness can spawn and complete" },
    cwd,
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
