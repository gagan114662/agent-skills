import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { newId } from "./db/id.js";
import { registerObservability } from "./observability/plugin.js";
import { registerCors } from "./http/cors.js";
import { registerMaintenance } from "./maintenance/gate.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { agentInterfaceRoutes } from "./routes/agent-interface.js";
import { acpRoutes } from "./routes/acp.js";
import { a2aRoutes } from "./routes/a2a.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { memoryRoutes } from "./routes/memory.js";
import { taskRoutes } from "./routes/tasks.js";
import { approvalRoutes } from "./routes/approvals.js";
import { agentSessionRoutes } from "./routes/agent-sessions.js";
import { preflightRoutes } from "./routes/preflight.js";
import type { PreflightReport } from "./runtime/preflight.js";
import {
  integrationsRoutes,
  defaultIntegrationsOptions,
  type IntegrationsRoutesOptions,
} from "./routes/integrations.js";
import { subagentRoutes } from "./routes/subagents.js";
import { marketingRoutes } from "./routes/marketing.js";
import { maybeAutoSeedOnSignup } from "./marketing/default.js";
import { gitReviewRoutes } from "./routes/git-review.js";
import { turnRoutes } from "./routes/turns.js";
import { createTurnController } from "./turns/default.js";
import type { TurnController } from "./turns/controller.js";
import { autonomyRoutes } from "./routes/autonomy.js";
import { teamRoutes } from "./routes/team.js";
import { searchRoutes } from "./routes/search.js";
import { mcpRoutes } from "./mcp/http.js";
import { attachRealtime } from "./realtime/gateway.js";
import { createDefaultSessionManager } from "./runtime/default.js";
import type { SessionManager } from "./runtime/manager.js";
import { runRoutes } from "./routes/run.js";
import { createDefaultRunProcessManager } from "./run/default.js";
import type { RunProcessManager } from "./run/manager.js";
import { deployRoutes } from "./routes/deploy.js";
import { createDefaultDeployManager } from "./deploy/default.js";
import type { DeployManager } from "./deploy/manager.js";
import { billingRoutes } from "./routes/billing.js";
import { createDefaultBilling } from "./billing/default.js";
import type { BillingManager } from "./billing/manager.js";
import type { PlanBillingService } from "./billing/plan-service.js";
import { createGitWorkspaceFromEnv } from "./git/default.js";
import type { GitWorkspaceService } from "./git/workspace.js";
import { GitWorktreeReaper } from "./git/reaper.js";
import { createGitHubProvider } from "./github/factory.js";
import type { GitHubProvider } from "./github/provider.js";
import { createDefaultTeamCoordinator } from "./team/default.js";
import type { TeamCoordinator } from "./team/coordinator.js";
import { createDefaultAutonomyEngine, autonomyLauncherFrom } from "./autonomy/default.js";
import type { AutonomyEngine } from "./autonomy/engine.js";
import { ventureRoutes } from "./routes/venture.js";
import { createConstitutionGuard } from "./constitution/default.js";
import {
  createDefaultVentureService,
  createDefaultVentureEngine,
  createVentureAdmission,
} from "./venture/default.js";
import { VentureService } from "./venture/service.js";
import type { VentureEngine } from "./venture/engine.js";
import { VentureAdmissionError, ventureGatedLauncher } from "./venture/admission.js";
import { demandRoutes } from "./routes/demand.js";
import { createDefaultDemandService } from "./demand/default.js";
import { DemandValidationService } from "./demand/service.js";
import { voiceRoutes } from "./routes/voice.js";
import { createDefaultCustomerVoiceService } from "./voice/default.js";
import { CustomerVoiceService } from "./voice/service.js";
import { moatRoutes } from "./routes/moat.js";
import { MoatService } from "./moat/service.js";
import { createDefaultMoatService } from "./moat/default.js";
import { listEvaluations } from "./db/repositories/venture.js";
import type { WatchdogEngine } from "./watchdog/engine.js";
import { createDefaultWatchdogEngine } from "./watchdog/default.js";
import type { SreEngine } from "./sre/engine.js";
import { createDefaultSreEngine } from "./sre/default.js";
import { sreRoutes } from "./routes/sre.js";
import type { FlywheelEngine } from "./flywheel/engine.js";
import { createDefaultFlywheelEngine } from "./flywheel/default.js";
import type { VerifierRunner } from "./verifiers/engine.js";
import { createDefaultVerifierRunner } from "./verifiers/default.js";
import { verifierRoutes } from "./routes/verifiers.js";
import { insightRoutes } from "./routes/insights.js";
import { createDefaultInsightMiner, createDefaultInsightEngine } from "./insight/default.js";
import { InsightMiner } from "./insight/service.js";
import type { InsightEngine } from "./insight/engine.js";
import { cloudWorkspaceRoutes } from "./routes/cloud-workspaces.js";
import { createDefaultCloudWorkspaceManager } from "./workspace/default.js";
import { scaleRoutes } from "./routes/scale.js";
import { createScale, type Scale } from "./scale/default.js";
import { founderConsoleRoutes } from "./routes/founder-console.js";
import { createDefaultFounderConsoleService } from "./founder-console/default.js";
import type { FounderConsoleService } from "./founder-console/service.js";
import { growthRoutes } from "./routes/growth.js";
import { createDefaultGrowthService } from "./growth/default.js";
import type { GrowthService } from "./growth/service.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { createDefaultPortfolioService } from "./portfolio/default.js";
import type { PortfolioService } from "./portfolio/service.js";
import { planningRoutes } from "./routes/planning.js";
import { createDefaultPlanningService } from "./planning/default.js";
import type { PlanningService } from "./planning/service.js";
import { automationRoutes } from "./routes/automations.js";
import { createDefaultAutomationEngine } from "./automations/default.js";
import { automationStore } from "./db/repositories/automations.js";
import type { AutomationEngine } from "./automations/engine.js";
import { missionControlRoutes } from "./routes/mission-control.js";
import { createDefaultMissionControlService } from "./mission-control/default.js";
import type { MissionControlService } from "./mission-control/service.js";
import { auditRoutes } from "./routes/audit.js";
import { createDefaultAuditService } from "./audit/default.js";
import type { AuditService } from "./audit/service.js";
import { createDefaultGatePricingService } from "./gate-pricing/default.js";
import type { GatePricingService } from "./gate-pricing/service.js";
import { AdmissionError } from "./scale/admission.js";
import { recordAdmissionDenied } from "./observability/metrics.js";
import type { SaturationCollectorDeps } from "./observability/saturation.js";
import { getPool } from "./db/index.js";
import { getRedis } from "./redis/index.js";
import type { CloudWorkspaceManager } from "./workspace/manager.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The #17 autonomy engine; `index.ts` starts its opt-in background timer. */
    autonomyEngine: AutonomyEngine;
    /** The #96 venture engine; `index.ts` starts its opt-in background tick (VENTURE_INTERVAL_MS). */
    ventureEngine: VentureEngine;
    /** The #105 fleet watchdog; `index.ts` starts its opt-in supervisor tick (WATCHDOG_INTERVAL_MS). */
    watchdogEngine: WatchdogEngine;
    /** The #112 SRE on-call loop; `index.ts` starts its opt-in tick (SRE_INTERVAL_MS). */
    sreEngine: SreEngine;
    /** The #119 evidence pricer; config default-OFF, driven per-workspace via `tick(workspaceId)`. */
    gatePricingService: GatePricingService;
    /** The #117 self-healing flywheel; `index.ts` starts its opt-in tick (FLYWHEEL_INTERVAL_MS). */
    flywheelEngine: FlywheelEngine;
    /** The #106 outcome-verifier runner; `index.ts` starts its opt-in tick (VERIFIERS_INTERVAL_MS). */
    verifierRunner: VerifierRunner;
    /** The #100 insight miner; `index.ts` starts its opt-in mining tick (INSIGHT_INTERVAL_MS). */
    insightEngine: InsightEngine;
    /** The #115 product planning loop; `index.ts` starts its opt-in tick (PLANNING_INTERVAL_MS). */
    planningEngine: PlanningService;
    /** The #147 automations engine; `index.ts` starts its opt-in tick (AUTOMATIONS_INTERVAL_MS). */
    automationEngine: AutomationEngine;
    /** The #55 cloud workspace manager; `index.ts` starts its opt-in idle sweep. */
    cloudWorkspaceManager: CloudWorkspaceManager;
    /**
     * The #70 git-worktree reaper; present only when a git repo is configured (`GIT_WORKSPACE_REPO`).
     * `index.ts` runs one sweep on boot (cleaning crash leftovers) + an opt-in periodic sweep.
     */
    gitWorktreeReaper?: GitWorktreeReaper;
  }
}

/**
 * Builds the Fastify app without binding a port, so it can be exercised in tests
 * via `app.inject(...)`. `src/index.ts` calls `listen`.
 *
 * Correlation (#19): `requestIdHeader` makes Fastify adopt an inbound `x-request-id`
 * for traceability across services; `genReqId` falls back to a uuidv7. The id is
 * stamped on every log line (`requestIdLogLabel`) and echoed in the response header
 * by the observability plugin.
 */
/** Options for {@link buildApp}; tests may inject a SessionManager with a fake runtime (#25). */
export interface BuildAppOptions {
  sessionManager?: SessionManager;
  /** #56 Run tab: tests inject a RunProcessManager with a fake provisioner/spawn; default builds one. */
  runManager?: RunProcessManager;
  /** #73 Deploy: tests inject a DeployManager over the dry-run provider; default builds one from env. */
  deployManager?: DeployManager;
  /** #98 Billing: tests inject a BillingManager over the none provider; default builds one from env. */
  billingManager?: BillingManager;
  /** #125 Pricing: tests inject a PlanBillingService over the none provider; default builds one from env. */
  planService?: PlanBillingService;
  /** Tests inject an AutonomyEngine and drive `tick()` deterministically (#17). */
  autonomyEngine?: AutonomyEngine;
  /** Tests inject a TeamCoordinator over a fake-runtime SessionManager (Team Mode). */
  teamCoordinator?: TeamCoordinator;
  /** Tests may inject a CloudWorkspaceManager (#55); defaults to the repo-backed one. */
  cloudWorkspaceManager?: CloudWorkspaceManager;
  /**
   * #57 deep dev integrations. Tests pass fakes (e.g. a fake IssueProvider, an in-memory config
   * loader); production builds the defaults over the shared SessionManager. Partial — anything
   * omitted falls back to the default.
   */
  integrations?: Partial<IntegrationsRoutesOptions>;
  /** #51 git/PR/review: the worktree+diff service (opt-in; absent → git/PR routes 501). */
  gitWorkspace?: GitWorkspaceService;
  /** #51 git/PR/review: the GitHub provider (tests inject a fake; default `none` from env). */
  gitHubProvider?: GitHubProvider;
  /** #53 plan mode / checkpoints / steering; defaults to one over the shared SessionManager + git. */
  turnController?: TurnController;
  /**
   * #71 cloud-scale bundle (admission + usage). Tests inject one and build their SessionManager over
   * the SAME `scale.admission`, so the usage route's in-flight counters match what the manager runs.
   * Default builds a fresh one (all caps off → unchanged #25 behavior).
   */
  scale?: Scale;
  /** #69 preflight/doctor: tests inject a report; default runs the live host-env check. */
  preflight?: () => PreflightReport;
  /** #96 venture loop: tests inject a service over a deterministic scorer; default builds the real one. */
  venture?: VentureService;
  /** #101 demand validation rails: tests inject one service (shared by routes + billing ingest + venture overlay). */
  demand?: DemandValidationService;
  /** #114 customer voice loop: tests inject one service (shared by routes + #104 console + venture overlay). */
  voice?: CustomerVoiceService;
  /** #103 moat accrual: tests inject a service over a fake ledger; default builds the real one. */
  moat?: MoatService;
  /** #105 fleet watchdog: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  watchdog?: WatchdogEngine;
  /** #112 SRE loop: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  sre?: SreEngine;
  /** #117 self-healing flywheel: tests inject an engine and drive `record`/`tickWorkspace()`. */
  flywheel?: FlywheelEngine;
  /** #106 outcome verifiers: tests inject a runner and drive `verify`/`tickWorkspace()`; default builds the real one. */
  verifiers?: VerifierRunner;
  /** #100 insight miner: tests inject a miner over a deterministic stub; default builds the real one. */
  insight?: InsightMiner;
  /**
   * #104 founder console: tests inject a read-only aggregation service over fakes; default builds one
   * over the SAME live `scale` + `billingManager` so its fleet/budget/revenue match what they enforce.
   */
  founderConsole?: FounderConsoleService;
  /** #119 evidence-priced autonomy: tests inject a pricer and drive `tick()`; default builds the real one. */
  gatePricing?: GatePricingService;
  /** #102 growth loop: tests inject a service over fakes; default builds the real repo-backed one. */
  growth?: GrowthService;
  /** #107 portfolio lifecycle loop: tests inject a service over fakes; default reads the live moat/
   * growth/demand/billing surfaces. */
  portfolio?: PortfolioService;
  /** #115 product planning loop: tests inject a service over a fake launcher; default builds the real one. */
  planning?: PlanningService;
  /** #147 automations: tests inject an engine over a fake launcher; default builds the real repo-backed one. */
  automations?: AutomationEngine;
  /** #147 mission control: tests inject a read-only service over fakes; default reads the live #25 sessions. */
  missionControl?: MissionControlService;
  /** #147 audit trail: tests inject a read-only service over fakes; default reads existing append-only rows. */
  audit?: AuditService;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => newId(),
  });
  app.register(cookie);
  // #108: env-gated CORS so the Vercel-hosted console (https://ipop.ai) can make credentialed calls
  // to this API on a different origin (https://api.ipop.ai). No-op unless RELOAD_WEB_ORIGIN is set.
  registerCors(app);
  // #71 cloud scale: ONE Admission instance (kill switch, budget, concurrency caps, region placement)
  // shared between the SessionManager (which mutates its counters) and the usage/founder-console/metrics
  // readers. Built here (before observability) so the #113 saturation sampler can read its global
  // in-flight count as the scrape-time queue-depth signal. With all caps 0 (the default) it admits
  // everything — unchanged #25 behavior.
  const scale = opts.scale ?? createScale(0);
  // #113 saturation signals sampled at /metrics scrape time: admission queue depth, PG pool wait, and
  // Redis ping latency (event-loop lag is a process-singleton inside saturation.ts). All fail-soft —
  // a slow/dead dependency degrades the metric, never the scrape (see plugin.ts withTimeout).
  const saturation: SaturationCollectorDeps = {
    queueDepth: () => scale.admission.snapshot("").global,
    pgPoolStats: () => {
      const p = getPool();
      return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
    },
    redisPing: async () => {
      const startedAt = performance.now();
      try {
        const redis = getRedis();
        if (redis.status !== "ready") await redis.connect().catch(() => undefined);
        if ((await redis.ping()) !== "PONG") return null;
        return (performance.now() - startedAt) / 1000;
      } catch {
        return null;
      }
    },
  };
  registerObservability(app, { saturation });
  // #99 disaster recovery: a root write-gate that rejects writes (503) while the platform is in
  // maintenance mode (a Redis flag, read per-request — flips in seconds with no redeploy). Installed
  // directly on the root like observability so it covers every route plugin. Reads always pass; an
  // unavailable Redis fails OPEN (never a write outage). ADR-0099 §1.
  registerMaintenance(app);
  // #71: map an admission denial (thrown by any launch path through SessionManager) to a clean HTTP
  // status — 402 for a budget breach, 429 for a hard stop / capacity — with a content-free reason.
  // A non-admission error falls through to Fastify's default handling (unchanged behavior).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AdmissionError) {
      recordAdmissionDenied(err.reason);
      const status = err.reason === "budget_exceeded" ? 402 : 429;
      return reply.code(status).send({ error: err.message, reason: err.reason });
    }
    // #96: the venture admission gate denies an autonomy launch lacking a fundable scorecard → 403.
    if (err instanceof VentureAdmissionError) {
      return reply.code(403).send({ error: err.message, reason: err.reason });
    }
    return reply.send(err);
  });
  app.register(healthRoutes);
  // #99 maintenance control: GET/POST /maintenance backs `reload maintenance on|off|status`.
  app.register(maintenanceRoutes);
  // #123 signup auto-seed needs the SessionManager (welcome launches), so authRoutes is registered
  // below, right after the manager is built.
  app.register(meRoutes);
  // #11 framework-agnostic agent interface: GET /me/channels (capability-filtered) + GET /openapi.json.
  app.register(agentInterfaceRoutes);
  // #12 protocol adapters (grouped with the agent surface): ACP runs ⇄ channel threads, A2A
  // handoff ⇄ tasks + AgentCard handshake. Both reuse the same identity/RBAC/IDOR helpers — no new
  // authority, no new table.
  app.register(acpRoutes);
  app.register(a2aRoutes);
  app.register(agentRoutes);
  app.register(channelRoutes);
  app.register(notificationRoutes);
  app.register(memoryRoutes);
  app.register(taskRoutes);
  // #13 human approval gates: agents submit sensitive actions; humans approve (→ execute) or reject.
  app.register(approvalRoutes);
  app.register(searchRoutes);
  // #10 MCP integration: a stateful Streamable-HTTP MCP server at /mcp. Each tool/resource is a
  // thin adapter over the existing repos + access helpers (no new authority); auth is the existing
  // agent Bearer token (#3) checked per request, and resource subscriptions bridge onto the #5 bus.
  app.register(mcpRoutes);
  // #25 cloud agent execution: the SessionManager owns the agent run server-side (close the
  // laptop, agents keep working). Default backend is `local`; tests may inject a fake-runtime
  // manager. It is cancelled+drained on server close so no run leaks past shutdown.
  // #71 cloud scale: the SessionManager mutates the SAME `scale.admission` counters built above (so the
  // usage route + #113 saturation queue-depth read what the manager runs). With all caps 0 (the
  // default) it admits everything — unchanged #25 behavior — but enables kill-switch-halts-launch + usage.
  const sessionManager = opts.sessionManager ?? createDefaultSessionManager(app.log, scale);
  app.register(agentSessionRoutes, { sessionManager });
  app.register(scaleRoutes, { admission: scale.admission, config: scale.config });
  // #69 preflight/doctor: GET /preflight reports whether the configured cloud + real-agent posture
  // is runnable (auth + harness availability), backing `reload doctor`. Secret-free (names only).
  app.register(preflightRoutes, { preflight: opts.preflight });
  // #57 deep dev integrations: issue→session, project slash commands, agent-config sync. Reuses the
  // same SessionManager and the base-launch gating; provider tokens stay on the #25 secrets path.
  app.register(
    integrationsRoutes,
    defaultIntegrationsOptions(sessionManager, { logger: app.log, ...opts.integrations }),
  );
  // #59 custom subagents / agent personas: define an @-mentionable persona (prompt + tool ceiling),
  // then invoke it in a channel. It runs the real harness AS its own agent member via the same
  // SessionManager, scoped to its tools, with its result threaded under the invoking @mention. The
  // SubagentService is the single RBAC gate (reuses the #9 capability ladder — no new authority).
  app.register(subagentRoutes, { sessionManager });
  // #123 marketing department fleet: seed a workspace into a working agency (a channel + a named agent
  // per marketing function), turn an @mention into a REAL harness session through the venture-gated
  // launcher (kill-switch + tenant-budget aware), and expose the team panel + its task records. External
  // sends stay #13-gated, sensitive-by-default. authRoutes is registered here too so signup can
  // auto-seed (config default-OFF) through the SAME SessionManager.
  app.register(authRoutes, {
    onWorkspaceCreated: (workspaceId: string, ownerMemberId: string) =>
      maybeAutoSeedOnSignup(sessionManager, workspaceId, ownerMemberId, app.log),
  });
  app.register(marketingRoutes, { sessionManager });
  // #56 Run tab: run a session's app for in-app preview + detect its localhost port, and route UI
  // annotations back to the agent (the #51 round trip). The RunProcessManager is SEPARATE from the
  // SessionManager (a dev server is long-lived; it must never finalize the session row). Killed on
  // server close so no preview process leaks past shutdown.
  const runManager = opts.runManager ?? createDefaultRunProcessManager(app.log);
  app.register(runRoutes, { runManager, sessionManager });
  app.addHook("onClose", async () => {
    runManager.shutdown();
    await sessionManager.shutdown();
  });
  // #73 Deploy: take a finished session's app to a live HTTPS URL through a swappable DeployProvider
  // (default = the no-spend dry-run backend; DEPLOY_PROVIDER=vercel switches to the real adapter, lazy).
  // Separate from the SessionManager/RunProcessManager — a deploy is a durable one-shot job whose live
  // URL is PERSISTED (the deployments table) rather than ephemeral; rollback re-promotes a prior deploy.
  const deployManager = opts.deployManager ?? createDefaultDeployManager(app.log);
  app.register(deployRoutes, { deployManager });
  // #98 Stripe revenue rails: a FUNDed venture's deployed app charges real money INBOUND through a
  // swappable BillingProvider (default = the no-network `none` backend; BILLING_PROVIDER=stripe switches
  // to the real adapter, lazy). A signature-verified webhook persists deduped revenue events per workspace
  // and turns each real payment into willingness-to-pay evidence the #96 venture scorecard consumes.
  // Outbound money (refunds/payouts/transfers) is NEVER here — it is a #13 approval-gated, recorded-only
  // action; payouts stay manual in the Stripe dashboard.
  // #98 rails + #125 pricing/plan layer share one provider + secrets; build both together unless a test
  // injected its own (the #98 tests inject only the manager and never exercise the plan routes).
  // #101 demand validation rails: ONE service instance shared by the demand routes, the billing webhook's
  // `demandIngestor` (so a `demand_smoke` checkout becomes an external `paid` signal), and the #96 venture
  // demand overlay (so the scorecard's demand dimension consumes only this externally-attributed evidence).
  const demandService = opts.demand ?? createDefaultDemandService(app.log);
  const billingDefaults =
    !opts.billingManager || !opts.planService ? createDefaultBilling(app.log, demandService) : null;
  const billingManager = opts.billingManager ?? billingDefaults!.billingManager;
  const planService = opts.planService ?? billingDefaults!.planService;
  app.register(billingRoutes, { billingManager, planService });
  // #104 founder console: ONE read-only aggregation endpoint that gives the owner fleet status, the
  // venture pipeline (#96), revenue/willingness-to-pay (#98), budget burn (#71), the pending #13
  // approval queue (with decision-SLA ages), and the kill/maintenance switches — the whole daily
  // review in one read. Built over the SAME `scale` (so fleet/budget match admission) + `billingManager`
  // (so revenue matches billing). Strictly read-only: approve/kill/maintenance flip through their
  // existing routes, never here. Tenant-scoped via `assertWorkspace`.
  // #103 moat accrual: the per-venture moat ledger + pure scoring. Recording/scoring always work; the
  // Founder Console stagnation flagging is config default-OFF. Built before the console so the console
  // can surface each venture's moat + flag the ones that have stopped compounding (read-only).
  const moatService = opts.moat ?? createDefaultMoatService();
  app.register(moatRoutes, {
    service: moatService,
    ventureIds: async (workspaceId) => (await listEvaluations(workspaceId)).map((e) => e.ideaId),
  });
  // #114 customer voice loop: ONE service instance shared by the voice routes (inbound webhook + tenant
  // reads + the #13-gated reply), the #104 founder console voice pane, and the #96 venture voice overlay
  // (so the scorecard's problemSeverity dimension consumes the same post-launch customer-voice evidence).
  // Built before the console so it can surface the voice pane.
  const voiceService = opts.voice ?? createDefaultCustomerVoiceService();
  app.register(voiceRoutes, { service: voiceService });
  // #102 growth loop: distribution instrumentation. Record per-venture growth events (acquisition/
  // activation/conversion/retention), score the funnel, surface the score to the #96 scorecard + #107
  // portfolio loop + #104 console, and let the marketing fleet (#123) propose channel experiments —
  // external posting stays behind the existing #13 `external.send` gate (a human posts). Default-OFF.
  // Built before the console + portfolio loop so both can read per-venture growth.
  const growthService = opts.growth ?? createDefaultGrowthService();
  // #107 portfolio lifecycle loop: kill discipline for LAUNCHED ventures (not just ideas). Reviews each
  // funded venture on growth (#102) / moat (#103) / demand (#101) / revenue (#98) / infra burn (#71),
  // decides DOUBLE_DOWN/MAINTAIN/PIVOT/SUNSET, and gates a SUNSET (kill) behind the #13 `portfolio.sunset`
  // approval (sensitive by default — a human approves; an agent never kills its own venture). On an
  // approved sunset the lesson is written to the #15 memory graph so it compounds. Reviews compute/persist
  // always (read-mostly); the proactive posture is config default-OFF. Built before the console so the
  // console can surface the compact portfolio pane.
  const portfolioService =
    opts.portfolio ??
    createDefaultPortfolioService({
      moat: moatService,
      growth: growthService,
      demand: demandService,
      billing: billingManager,
    });
  const founderConsole =
    opts.founderConsole ??
    createDefaultFounderConsoleService({
      scale,
      billing: billingManager,
      moat: moatService,
      portfolio: portfolioService,
      voice: voiceService,
    });
  app.register(founderConsoleRoutes, { service: founderConsole });
  app.register(growthRoutes, { service: growthService });
  app.register(portfolioRoutes, { service: portfolioService });
  // #115 product planning loop: feedback + metrics → RICE-ranked backlog → specs → proposed build
  // sessions. Record backlog items (RICE inputs derived from evidence counts), read the ranked backlog,
  // and run the planning tick — the top item is drafted into a spec and proposed through the
  // venture-gated #96 launcher; pivots / over-budget / not-#95-allowed dispatches #13-gate. Default-OFF.
  const planningService = opts.planning ?? createDefaultPlanningService(sessionManager);
  app.register(planningRoutes, { service: planningService });
  app.addHook("onClose", async () => {
    planningService.stop();
  });
  app.decorate("planningEngine", planningService);
  // #51 git/PR/diff/review: each session's worktree becomes a reviewable diff + optional GitHub PR,
  // with review comments routed back to the agent as a new session. The git workspace is opt-in
  // (GIT_WORKSPACE_REPO) — absent, the diff/PR routes return 501; the GitHub provider defaults to
  // `none` so CI never calls GitHub. Tests inject a temp-repo git service + a fake provider.
  const gitWorkspace = opts.gitWorkspace ?? createGitWorkspaceFromEnv();
  const gitHubProvider = opts.gitHubProvider ?? createGitHubProvider();
  app.register(gitReviewRoutes, { sessionManager, gitWorkspace, gitHubProvider });
  // #70 local worktree isolation: when a git repo is configured each session runs in its own worktree
  // (#51); the reaper removes those whose session this process is no longer driving. `index.ts` sweeps
  // once on boot (clearing crash leftovers — "no orphans after a crash/restart") + on an opt-in timer.
  // The keep-set is the SessionManager's live ids, so a concurrent run is never reaped.
  if (gitWorkspace) {
    app.decorate("gitWorktreeReaper", new GitWorktreeReaper(gitWorkspace, sessionManager, app.log));
  }
  // #53 plan mode, checkpoints & steering: an agent proposes a plan (work blocks until a human
  // approves / approves-with-feedback / rejects), each turn is a revertible checkpoint (files + chat),
  // and a live session can be steered. Reuses the SessionManager (plan = two launches with a gate) and
  // the opt-in #51 worktree (commitTurn/resetTo); checkpoint/revert 501 without a configured repo.
  const turnController =
    opts.turnController ?? createTurnController(sessionManager, gitWorkspace ?? null);
  app.register(turnRoutes, { controller: turnController, sessionManager });
  // Team Mode: run N agents in parallel on one feature, each on its own subtask/branch, kept in
  // the loop over the channel's shared team protocol. The coordinator reuses the same
  // SessionManager (so per-session ResourceCaps still apply) and adds a team-level concurrency cap.
  const teamCoordinator =
    opts.teamCoordinator ?? createDefaultTeamCoordinator(app.log, sessionManager);
  app.register(teamRoutes, { coordinator: teamCoordinator });
  // #17 autonomy: the AutonomyEngine drives the server-owned activity loop (pools, workflows,
  // handoffs, approval gates, guards + kill switch). The background timer is opt-in
  // (AUTONOMY_INTERVAL_MS, default off) and started in index.ts; tests inject the engine and
  // drive `tick()`. It is stopped on server close so no timer leaks past shutdown.
  // #84: the engine launches real agent sessions through the shared #25 SessionManager (past the
  // same kill-switch/budget/rate-limit guards), so autonomy executes work instead of only narrating.
  // #96 venture loop: the YC-fundability gate. The service runs the loop (intake → evidence → dual
  // persona scoring → decide → FUND/ITERATE/KILL/ESCALATE); the admission gate decorates the autonomy
  // launcher so a session is only launched for a workspace holding a passing, unexpired scorecard.
  // The gate is config default-OFF (`VentureAdmission.check` short-circuits to admit), so wrapping the
  // launcher is safe for every workspace that hasn't opted in — unchanged behavior by default.
  // #146 YC Startup Constitution guard: scores every SOURCE/FUND/KILL decision against the Articles
  // and (Article I love-gate only) can downgrade a B2B FUND → ESCALATE. Reads the #101 demand rails for
  // evidence; feeds each violation to the #117 flywheel (lazily — the engine is created below) so a
  // REPEAT fingerprints into an issue. Config default-OFF: until `constitution.enabled` is set, the
  // guard scores nothing and behavior is unchanged.
  const constitutionGuard = createConstitutionGuard({
    demand: demandService,
    flywheelRecord: (event) => app.flywheelEngine.record(event),
    logger: app.log,
  });
  // #114 customer-voice overlay is also threaded into the venture service so real post-launch voice can
  // replace the synthetic problemSeverity dimension (default-OFF until the voice loop is configured).
  const ventureService =
    opts.venture ??
    createDefaultVentureService(undefined, demandService, constitutionGuard, voiceService);
  app.register(ventureRoutes, { service: ventureService });
  // #101 demand routes: register/launch a fake-door smoke test, capture funnel signals, read the verdict
  // against the LOCKED bar. The apex `paid` signal has no route — it arrives only via the #98 webhook.
  app.register(demandRoutes, { service: demandService });
  // The scheduled tick advances active evaluations on infrastructure time (default OFF — started in
  // index.ts only when VENTURE_INTERVAL_MS > 0); each advance self-gates on the kill switch + budget.
  const ventureEngine = createDefaultVentureEngine(app.log, demandService, constitutionGuard);
  app.addHook("onClose", async () => {
    ventureEngine.stop();
  });
  app.decorate("ventureEngine", ventureEngine);
  const ventureAdmission = createVentureAdmission();
  const gatedAutonomyLauncher = ventureGatedLauncher(
    autonomyLauncherFrom(sessionManager),
    ventureAdmission,
  );
  const autonomyEngine =
    opts.autonomyEngine ??
    createDefaultAutonomyEngine(app.log, sessionManager, gatedAutonomyLauncher);
  app.register(autonomyRoutes, { engine: autonomyEngine });
  app.addHook("onClose", async () => {
    autonomyEngine.stop();
  });
  app.decorate("autonomyEngine", autonomyEngine);
  // #105 fleet watchdog: the supervisor that detects stalled agent sessions (no heartbeat past the
  // stale cutoff) and revives them through the SAME #92 launcher (past the same #71 admission), under
  // a durable bounded restart policy (backoff, max revivals/window, dollar-aware), escalating a
  // hopeless lineage to the #13 queue. The background tick is opt-in (WATCHDOG_INTERVAL_MS, default
  // off) and started in index.ts; tests inject the engine and drive `tickWorkspace()`. It is config
  // default-OFF (`watchdog.enabled`), so wiring it changes nothing until a deployment opts in. Stopped
  // on server close so no timer leaks past shutdown.
  const watchdogEngine = opts.watchdog ?? createDefaultWatchdogEngine(app.log, sessionManager);
  app.addHook("onClose", async () => {
    watchdogEngine.stop();
  });
  app.decorate("watchdogEngine", watchdogEngine);
  // #112 SRE loop: the agent on-call. It reads the existing #19 `/metrics` + health probes, evaluates
  // each opted-in workspace's declared SLOs (availability / p95 latency / queue lag) against their
  // error budgets, and on a breach opens a durable `sre_incidents` row, notifies, and launches a
  // triage agent through the SAME #92 launcher (past the same #71 admission) with a failure bundle.
  // A critical breach escalates risky remediation to the #13 queue; recovery resolves the incident
  // and drafts a postmortem under docs/postmortems/ (linked from the #104 Founder Console). The tick
  // is opt-in (SRE_INTERVAL_MS, default off) and started in index.ts; tests inject the engine and
  // drive `tickWorkspace()`. Config default-OFF (`sre.enabled`), so wiring it changes nothing until a
  // deployment opts in. Stopped on server close so no timer leaks past shutdown. Read-only routes.
  const sreEngine = opts.sre ?? createDefaultSreEngine(app.log, sessionManager);
  app.addHook("onClose", async () => {
    sreEngine.stop();
  });
  app.decorate("sreEngine", sreEngine);
  app.register(sreRoutes);
  // #106 outcome verifiers: read-only surface for a workspace's durable verification verdicts.
  app.register(verifierRoutes);
  // #119 evidence-priced autonomy: the pricer that turns the static human/AI split into a per-action
  // experiment. It reads the trailing window of #13 decision outcomes per action class (recorded into
  // gate_evidence on every approve/reject) and, with structural hysteresis, RELAXes a clean reversible
  // class (creates a #95 auto-approve rule) or RE-TIGHTENs a regressed one (revokes it) — every change
  // audited (gate_boundary_changes) and surfaced in the #104 console. Invariant classes (outbound money,
  // external sends, secrets, the #13 hard list) can NEVER auto-relax (enforced in the type system). It is
  // config default-OFF (`gatePricing.enabled`), so wiring it changes nothing until a deployment opts in.
  // It is driven per-workspace via `tick(workspaceId)` (a fleet scheduler can drive it on infrastructure
  // time, like the venture/watchdog ticks); tests drive `tick()` directly. Decorated for that access.
  const gatePricingService = opts.gatePricing ?? createDefaultGatePricingService(app.log);
  app.decorate("gatePricingService", gatePricingService);
  // #117 self-healing flywheel: the second infrastructure-time supervisor. It fingerprints + dedups
  // every agent failure (redacted via #25), synthesizes ONE GitHub issue per fingerprint via the #57
  // path on a kill-switch-gated tick, and dispatches budget-/concurrency-capped fix sessions through
  // the SAME #92 launcher (auto only for #95-allowed classes, else queued for #104). It is config
  // default-OFF (`flywheel.enabled`) + the timer is opt-in (FLYWHEEL_INTERVAL_MS, started in index.ts),
  // so wiring it changes nothing until a deployment opts in. Stopped on server close.
  const flywheelEngine = opts.flywheel ?? createDefaultFlywheelEngine(app.log, sessionManager);
  app.addHook("onClose", async () => {
    flywheelEngine.stop();
  });
  app.decorate("flywheelEngine", flywheelEngine);
  // #147 automations: owner-defined scheduled/webhook agent tasks. A default-OFF, kill-switch-gated
  // tick launches each due automation through the SAME #123 venture-gated launcher a human @mention
  // uses (so #96/#71 gating + #13-gated sends are inherited), recording a durable run. Run-now + the
  // public webhook route share `runAutomation`. The timer is opt-in (AUTOMATIONS_INTERVAL_MS, started
  // in index.ts). Mission control + the audit trail are read-only viewers over existing rows.
  const automationEngine = opts.automations ?? createDefaultAutomationEngine(app.log, sessionManager);
  app.register(automationRoutes, { engine: automationEngine, store: automationStore });
  app.addHook("onClose", async () => {
    automationEngine.stop();
  });
  app.decorate("automationEngine", automationEngine);
  const missionControl = opts.missionControl ?? createDefaultMissionControlService();
  app.register(missionControlRoutes, { service: missionControl, sessionManager });
  const auditService = opts.audit ?? createDefaultAuditService();
  app.register(auditRoutes, { service: auditService });
  // #106 outcome verifiers: the measured-gate runner. It turns non-code claims (deploy live? revenue
  // real? growth moved? fix held?) into durable `verifier_results` evidence rows via pure verifier
  // modules, and a FAILED verification opens a #13 escalation (never silently passes). It is config
  // default-OFF (`verifiers.enabled`) + the timer is opt-in (VERIFIERS_INTERVAL_MS, started in
  // index.ts), so wiring it changes nothing until a deployment opts in. Stopped on server close.
  const verifierRunner = opts.verifiers ?? createDefaultVerifierRunner(app.log);
  app.addHook("onClose", async () => {
    verifierRunner.stop();
  });
  app.decorate("verifierRunner", verifierRunner);
  // #100 insight miner: the SOURCE-stage upgrade for the venture loop. It ranks evidence sources
  // ("the list is the strategy"), mines them into structured insights (the agent-session path,
  // kill-switch + #71-budget gated), captures owner secrets as first-class artifacts, dedupes killed
  // angles against the #15 memory graph (never return uncited), and promotes insights into #96 venture
  // ideas with provenance links. It is config default-OFF (`insight.enabled`) + the timer is opt-in
  // (INSIGHT_INTERVAL_MS, started in index.ts), so wiring it changes nothing until a deployment opts in.
  const insightMiner = opts.insight ?? createDefaultInsightMiner();
  app.register(insightRoutes, { miner: insightMiner });
  const insightEngine = createDefaultInsightEngine(app.log);
  app.addHook("onClose", async () => {
    insightEngine.stop();
  });
  app.decorate("insightEngine", insightEngine);
  // #55 persistent & shared cloud workspaces: durable cloud workspaces (sleep/wake around the #25
  // snapshot resume key), cloud→local file mirror with setup-on-first-mirror, and scoped/revocable
  // collaborator sharing. The idle sweep is opt-in (CLOUD_SWEEP_INTERVAL_MS, default off) and
  // started in index.ts; routes use the manager + the #9 access ladder + the #5 bus.
  const cloudWorkspaceManager =
    opts.cloudWorkspaceManager ?? createDefaultCloudWorkspaceManager(app.log);
  app.register(cloudWorkspaceRoutes, { manager: cloudWorkspaceManager });
  app.decorate("cloudWorkspaceManager", cloudWorkspaceManager);
  // #5 realtime gateway: WebSocket delivery + presence on top of the REST endpoints.
  // Its Redis subscriber is created lazily on the first socket, so inject-only tests
  // and the no-Redis CI job stay Redis-free.
  attachRealtime(app);
  return app;
}
