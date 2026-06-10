/**
 * Cloud e2e / soak proof (#68).
 *
 * Drives N concurrent agent sessions through the SAME `AgentRuntime` the server uses
 * (`createRuntime`) with the configured harness, then reports per-session status, spin-up latency,
 * time-to-first-output, and that every session reached a terminal (reaped) state. It runs against:
 *
 *   - `AGENT_RUNTIME=local` (default): real host child processes, NO cloud spend — proves
 *     concurrency, isolation, live streaming, and teardown for free (CI/dev-safe).
 *   - `AGENT_RUNTIME=sandbox` + `AGENT_HARNESS=claude-code` + `VERCEL_*`: the real cloud proof
 *     (billable) — a real coding agent in a per-session Vercel Sandbox.
 *
 * Run:
 *   SOAK_N=5 pnpm --filter @reload/server soak
 *   AGENT_RUNTIME=sandbox AGENT_HARNESS=claude-code VERCEL_TOKEN=... VERCEL_TEAM_ID=... \
 *     VERCEL_PROJECT_ID=... SOAK_N=3 pnpm --filter @reload/server soak
 *
 * Never commit a token; keep it in a local, gitignored .env.
 */
import { loadEnv } from "../src/env.js";
import { createRuntime } from "../src/runtime/factory.js";
import type { AgentJob, RunningSession, RuntimeResult } from "../src/runtime/types.js";

function intEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

interface SoakRow {
  id: string;
  spinupMs: number;
  firstOutputMs: number;
  sandboxId?: string;
  result: RuntimeResult;
}

async function runOne(
  runtime: ReturnType<typeof createRuntime>,
  job: AgentJob,
): Promise<SoakRow> {
  const t0 = Date.now();
  let firstOutputMs = 0;
  const running: RunningSession = await runtime.start(job, {
    onOutput: () => {
      if (firstOutputMs === 0) firstOutputMs = Date.now() - t0;
    },
  });
  const spinupMs = Date.now() - t0;
  const result = await running.wait(); // resolves only after teardown (snapshot + stop)
  return { id: job.sessionId, spinupMs, firstOutputMs, sandboxId: running.sandboxId, result };
}

async function main(): Promise<void> {
  const agent = loadEnv().agent;
  const n = intEnv("SOAK_N", 3);
  const task = process.env.SOAK_TASK ?? "Print a one-line greeting, then exit 0.";
  console.log(`[soak] runtime=${agent.runtime} harness=${agent.harness} sessions=${n}`);

  const runtime = createRuntime(agent);
  const jobs: AgentJob[] = Array.from({ length: n }, (_v, i) => ({
    sessionId: `soak-${i}`,
    workspaceId: "soak",
    command: agent.harnessCommand,
    args: agent.harnessArgs,
    env: { AGENT_TASK: task },
    secrets: {},
    caps: agent.caps,
  }));

  const started = Date.now();
  const rows = await Promise.all(jobs.map((j) => runOne(runtime, j)));
  const wallMs = Date.now() - started;

  let completed = 0;
  for (const r of rows) {
    if (r.result.status === "completed") completed++;
    console.log(
      `[soak] ${r.id}: status=${r.result.status} exit=${r.result.exitCode ?? "n/a"} ` +
        `spinup=${r.spinupMs}ms ttfo=${r.firstOutputMs}ms ` +
        `sandbox=${r.sandboxId ?? "-"} snapshot=${r.result.snapshotId ?? "-"}`,
    );
  }
  // wait() resolving for all rows is itself the reaping proof: each session ran teardown.
  const spinups = rows.map((r) => r.spinupMs).sort((a, b) => a - b);
  const p50 = spinups[Math.floor(spinups.length / 2)] ?? 0;
  const max = spinups[spinups.length - 1] ?? 0;
  console.log(
    `[soak] DONE — ${completed}/${n} completed & reaped, wall=${wallMs}ms, ` +
      `spin-up p50=${p50}ms max=${max}ms`,
  );
  if (completed !== n) {
    console.error(`[soak] FAILED — ${n - completed} session(s) did not complete`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[soak] error:", err);
  process.exitCode = 1;
});
