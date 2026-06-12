import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { closeDb } from "./db/index.js";
import { closeRedis } from "./redis/index.js";
import { isMaintenanceActive } from "./maintenance/flag.js";
import { backfillMarketingDepartments } from "./marketing/default.js";

const env = loadEnv();
const app = buildApp();

// #17 autonomy: start the opt-in background loop (AUTONOMY_INTERVAL_MS; default 0 = off). The
// engine is stopped on server close via the onClose hook registered in buildApp.
app.autonomyEngine.start(env.autonomy.intervalMs);

// #96 venture loop: start the opt-in scheduled tick (VENTURE_INTERVAL_MS; default 0 = off) that
// advances active evaluations on infrastructure time. Stopped on server close via buildApp's hook.
app.ventureEngine.start(env.venture.intervalMs);

// #105 fleet watchdog: start the opt-in supervisor tick (WATCHDOG_INTERVAL_MS; default 0 = off) that
// detects stalled sessions and revives/escalates them. Stopped on server close via buildApp's hook.
app.watchdogEngine.start(env.watchdog.intervalMs);

// #112 SRE loop: start the opt-in on-call tick (SRE_INTERVAL_MS; default 0 = off) that evaluates SLOs
// off /metrics + health, opens incidents, launches triage, and drafts postmortems. Self-gates on the
// #99 maintenance flag + the #17 kill switch. Stopped on server close via buildApp's hook.
app.sreEngine.start(env.sre.intervalMs);
// #117 self-healing flywheel: start the opt-in tick (FLYWHEEL_INTERVAL_MS; default 0 = off) that turns
// deduped failures into GitHub issues and dispatches fix agents. Stopped on server close via buildApp.
app.flywheelEngine.start(env.flywheel.intervalMs);

// #106 outcome verifiers: start the opt-in tick (VERIFIERS_INTERVAL_MS; default 0 = off) that turns
// non-code claims into durable measured verdicts and escalates failures. Self-gates on the #99
// maintenance flag + the #17 kill switch. Stopped on server close via buildApp's hook.
app.verifierRunner.start(env.verifiers.intervalMs);

// #100 insight miner: start the opt-in mining tick (INSIGHT_INTERVAL_MS; default 0 = off) that ranks
// evidence sources and mines them into structured insights for the venture loop. Stopped on close.
app.insightEngine.start(env.insight.intervalMs);

// #115 product planning loop: start the opt-in tick (PLANNING_INTERVAL_MS; default 0 = off) that
// re-ranks the backlog, drafts a spec for the top item, and proposes a build session (venture-gated,
// budget + kill-switch aware). Stopped on server close via buildApp.
app.planningEngine.start(env.planning.intervalMs);

// #172 self-shipping loop: start the opt-in tick (BUILDLOOP_INTERVAL_MS; default 0 = off) that picks
// the next agent-ok issue, dispatches a cloud build session, auto-reviews the PR against the house
// rubric, and auto-merges within guardrails (else escalates). Stopped on server close via buildApp.
app.buildLoopEngine.start(env.buildLoop.intervalMs);

// #147 automations: start the opt-in tick (AUTOMATIONS_INTERVAL_MS; default 0 = off) that launches
// due scheduled automations through the #123 venture-gated path. Stopped on server close via buildApp.
app.automationEngine.start(env.automations.intervalMs);

// #152 workflows: start the opt-in tick (WORKFLOWS_INTERVAL_MS; default 0 = off) that fires due
// scheduled workflows (trigger → conditions → actions) through the same gated paths. Stopped on close.
app.workflowEngine.start(env.workflows.intervalMs);

// #55 cloud workspaces: opt-in idle sweep (CLOUD_SWEEP_INTERVAL_MS; default 0 = off) that sleeps
// workspaces idle longer than CLOUD_IDLE_MS to save resources. Tests drive sweepIdle() directly.
let sweepTimer: NodeJS.Timeout | undefined;
if (env.cloud.sweepIntervalMs > 0) {
  sweepTimer = setInterval(() => {
    // #99: pause the sweep during maintenance (same Redis flag the write-gate + autonomy loop read).
    void isMaintenanceActive().then((paused) => {
      if (paused) return;
      const idleBefore = new Date(Date.now() - env.cloud.idleMs);
      return app.cloudWorkspaceManager
        .sweepIdle(idleBefore)
        .catch((err) => app.log.error({ err }, "cloud workspace idle sweep failed"));
    });
  }, env.cloud.sweepIntervalMs);
  sweepTimer.unref();
}

// #70 local worktree isolation: when a git repo is configured, reap per-session worktrees this process
// is no longer driving. One sweep on boot clears anything a crashed run left behind ("no orphans after
// a crash/restart"); the recurring timer is opt-in (GIT_WORKTREE_REAP_INTERVAL_MS; default 0 = off).
// sweep() never throws, so a reaper hiccup can never crash startup. No repo configured → no reaper.
let reapTimer: NodeJS.Timeout | undefined;
if (app.gitWorktreeReaper) {
  const reaper = app.gitWorktreeReaper;
  void reaper.sweep();
  if (env.git.reapIntervalMs > 0) {
    reapTimer = setInterval(() => void reaper.sweep(), env.git.reapIntervalMs);
    reapTimer.unref();
  }
}

// #138 marketing department fleet: idempotently backfill the agency (channels + named agents) for every
// existing enabled workspace, once on boot — the only path that reaches workspaces created before the
// fleet was turned on (the owner's). Per-workspace gated on config (default OFF → no-op everywhere the
// fleet isn't enabled) and best-effort, so it never spends and never crashes startup.
void backfillMarketingDepartments(app.log).catch((err) =>
  app.log.error({ err }, "marketing department backfill sweep failed"),
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  if (sweepTimer) clearInterval(sweepTimer);
  if (reapTimer) clearInterval(reapTimer);
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then((address) => app.log.info(`Reload server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
