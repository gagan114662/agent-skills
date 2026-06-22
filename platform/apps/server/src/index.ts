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
// #193 self-healing ops: start the opt-in tick (SELF_HEALING_INTERVAL_MS; default 0 = off) that probes
// every live venture surface, evaluates per-venture uptime/error/queue thresholds, and dispatches
// bounded remediation (restart auto, rollback/scale #13-gated), self-filing postmortems on escalation.
// Self-gates on the #99 maintenance flag + the #17 kill switch. Stopped on server close via buildApp.
app.selfHealingEngine.start(env.selfHealing.intervalMs);
// #117 self-healing flywheel: start the opt-in tick (FLYWHEEL_INTERVAL_MS; default 0 = off) that turns
// deduped failures into GitHub issues and dispatches fix agents. Stopped on server close via buildApp.
app.flywheelEngine.start(env.flywheel.intervalMs);
// #171 self-QA loop: start the opt-in tick (SELFQA_INTERVAL_MS; default 0 = off) that drives the
// synthetic-user E2E QA pass against the live product and files its own deduped bug issues. The always-on
// entry is the `selfqa:run` CLI in CI; the timer is for an in-process nightly. Stopped on close via buildApp.
app.selfqaEngine.start(env.selfqa.intervalMs);

// #106 outcome verifiers: register the opt-in tick (VERIFIERS_INTERVAL_MS; default 0 = off) that turns
// non-code claims into durable measured verdicts and escalates failures. Self-gates on the #99
// maintenance flag + the #17 kill switch. Driven by the #559 durable scheduler (started below).
app.scheduler.register({
  key: "verifiers",
  intervalMs: env.verifiers.intervalMs,
  run: () => app.verifierRunner.tickAll(),
});

// #100 insight miner: start the opt-in mining tick (INSIGHT_INTERVAL_MS; default 0 = off) that ranks
// evidence sources and mines them into structured insights for the venture loop. Stopped on close.
app.insightEngine.start(env.insight.intervalMs);

// #115 product planning loop: register the opt-in tick (PLANNING_INTERVAL_MS; default 0 = off) that
// re-ranks the backlog, drafts a spec for the top item, and proposes a build session (venture-gated,
// budget + kill-switch aware). Driven by the #559 durable scheduler (started below).
app.scheduler.register({
  key: "planning",
  intervalMs: env.planning.intervalMs,
  run: () => app.planningEngine.tickAll(),
});

// #197 venture memory & planning: register the opt-in weekly tick (VENTURE_PLANNING_INTERVAL_MS; default
// 0 = off) that drafts each venture's next-week plan from memory + scorecard + OKR drift, cites the #200
// premortem, and #13-gates it to the owner. Driven by the #559 durable scheduler (started below).
app.scheduler.register({
  key: "venture_memory",
  intervalMs: env.ventureMemory.intervalMs,
  run: () => app.ventureMemoryEngine.tickAll(),
});

// #187 venture factory: start the opt-in opportunity-scanner tick (VENTURE_FACTORY_INTERVAL_MS; default
// 0 = off) that advances `scanned` candidates through the edge gate into validation. The factory itself
// is config default-OFF + owner-workspace-first; nothing autonomous runs until a deployment opts in.
app.ventureFactoryEngine.start(env.ventureFactory.intervalMs);

// #416 autonomous work cadence: start the opt-in tick (RELOAD_CADENCE_INTERVAL_MS; default 0 = off) that
// keeps the fleet working ON ipop.ai's own growth — one draft-only dogfood task per cycle. The cadence is
// config default-OFF + owner-workspace-first + hard per-day capped; nothing autonomous runs until a
// deployment opts in. Stopped on server close via buildApp.
app.cadenceEngine.start(env.cadence.intervalMs);

// #283 SkillOpt-Sleep: start the opt-in nightly tick (RELOAD_SKILLOPT_INTERVAL_MS; default 0 = off) that
// runs each owner workspace's offline self-improvement cycle — harvest → mine → gate → stage at most one
// bounded skill-doc proposal in the #13 queue, and durably record the run's before/after signal. Config
// default-OFF + owner-workspace-first; it edits no doc and takes no money/external action (adoption stays
// human-gated), so nothing autonomous runs until a deployment opts in. Stopped on server close via buildApp.
app.skilloptEngine.start(env.skillopt.intervalMs);

// #172 self-shipping loop: start the opt-in tick (BUILDLOOP_INTERVAL_MS; default 0 = off) that picks
// the next agent-ok issue, dispatches a cloud build session, auto-reviews the PR against the house
// rubric, and auto-merges within guardrails (else escalates). Stopped on server close via buildApp.
app.buildLoopEngine.start(env.buildLoop.intervalMs);

// #173 founder briefings: start the opt-in reporting tick (BRIEFINGS_INTERVAL_MS; default 0 = off) that
// delivers each workspace's daily brief + weekly P&L report to the owner (the idempotency watermark
// dedups repeats within a period). Stopped on server close via buildApp.
app.founderBriefingsEngine.start(env.briefings.intervalMs);

// #416 content cadence: start the opt-in tick (CONTENT_CADENCE_INTERVAL_MS; default 0 = off) that briefs
// the fleet to write+publish the next target query so it ships a steady stream of on-site content instead
// of re-auditing the homepage (per-workspace flags are default-OFF + owner-first). Stopped on server close.
app.contentCadenceEngine.start(env.contentCadence.intervalMs);

// #194 finance ledger: start the opt-in posting/close tick (FINANCE_INTERVAL_MS; default 0 = off) that
// posts each enabled workspace's external receipts into the per-venture ledger and refreshes the current
// period's close pack (the idempotent upsert makes a repeat tick a no-op). Stopped on server close via buildApp.
app.financeEngine.start(env.finance.intervalMs);

// #188 venture monetization: start the opt-in activation tick (MONETIZATION_INTERVAL_MS; default 0 = off)
// that mints a venture's REAL payment link (inbound-only, with the venture's OWN Stripe key) ONCE the
// owner has approved its activation in the #13 money queue. Stopped on server close via buildApp.
app.monetizationEngine.start(env.monetization.intervalMs);

// #147 automations: start the opt-in tick (AUTOMATIONS_INTERVAL_MS; default 0 = off) that launches
// due scheduled automations through the #123 venture-gated path. Stopped on server close via buildApp.
app.automationEngine.start(env.automations.intervalMs);

// #152 workflows: register the opt-in tick (WORKFLOWS_INTERVAL_MS; default 0 = off) that fires due
// scheduled workflows (trigger → conditions → actions) through the same gated paths.
app.scheduler.register({
  key: "workflows",
  intervalMs: env.workflows.intervalMs,
  run: () => app.workflowEngine.tickAll(),
});

// #559 durable, single-leader scheduler: begin the single poll loop now that every restart-safe engine
// tick is registered. Each due job is claimed via a persisted leader lease (exactly-once across replicas),
// resumes from its persisted cursor after a restart, and is retried on bounded backoff on failure. The
// scheduler is stopped on server close via buildApp's onClose hook.
app.scheduler.start();

// #170 Slack-native: start the opt-in daily-digest tick (SLACK_DIGEST_INTERVAL_MS; default 0 = off)
// that DMs each opted-in workspace's owner the fleet digest. Stopped on server close via buildApp.
app.slackDigestEngine.start(env.slack.intervalMs);

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
