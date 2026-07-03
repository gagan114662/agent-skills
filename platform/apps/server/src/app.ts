import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { loadEnv } from "./env.js";
import { newId } from "./db/id.js";
import { REDACTION_MASK } from "./runtime/redact.js";
import { registerObservability } from "./observability/plugin.js";
import { registerCors } from "./http/cors.js";
import { registerPublicRateLimits } from "./http/rate-limit.js";
import { registerMaintenance } from "./maintenance/gate.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import { healthRoutes } from "./routes/health.js";
import { siteRoutes } from "./routes/site.js";
import { publicDogfoodRoutes } from "./routes/public-dogfood.js";
import type { ContentSource } from "./site/content.js";
import { authRoutes } from "./routes/auth.js";
import { createDefaultAuthSessionCleanupEngine } from "./auth/default-session-cleanup.js";
import type { AuthSessionCleanupEngine } from "./auth/session-cleanup.js";
import { googleAuthRoutes, type GoogleAuthRoutesOptions } from "./routes/google-auth.js";
import { sampleRoutes, type SampleRoutesOptions } from "./routes/sample.js";
import { meRoutes } from "./routes/me.js";
import { claudeConnectRoutes, type ClaudeConnectRoutesOptions } from "./routes/claude-connect.js";
import { agentInterfaceRoutes } from "./routes/agent-interface.js";
import { acpRoutes } from "./routes/acp.js";
import { a2aRoutes } from "./routes/a2a.js";
import { agentRoutes } from "./routes/agents.js";
import { channelRoutes } from "./routes/channels.js";
import { notificationRoutes } from "./routes/notifications.js";
import { memoryRoutes } from "./routes/memory.js";
import { decisionsRoutes } from "./routes/decisions.js";
import { createDefaultDecisionService } from "./decisions/default.js";
import { captureDecisionsFromDeliverable } from "./decisions/capture.js";
import { tracesRoutes } from "./routes/traces.js";
import { taskRoutes } from "./routes/tasks.js";
import { approvalRoutes } from "./routes/approvals.js";
import { buildAcquisitionRegistry } from "./acquisition/default.js";
import { createDefaultApprovalExpiryEngine } from "./approvals/default.js";
import type { ApprovalExpiryEngine } from "./approvals/expiry-engine.js";
import { governanceRoutes } from "./routes/governance.js";
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
import { agentRegistryRoutes } from "./routes/agent-registry.js";
import { createAgentRegistryService } from "./agent-registry/default.js";
import { parseHandoffChain } from "./agent-registry/handoff.js";
import { maybeAutoSeedOnSignup, buildMarketingMentionTrigger, createRoomBriefLauncher } from "./marketing/default.js";
import { setMarketingMentionTrigger } from "./messaging/delivery.js";
import { createExternalRoomMirror, setExternalRoomMirror } from "./messaging/external-room-mirror.js";
import { createIMessageRoomMirror, setIMessageRoomMirror } from "./messaging/imessage-room-mirror.js";
import { slackRoutes } from "./routes/slack.js";
import { createDefaultSlackService, createDefaultSlackDigestEngine } from "./slack/default.js";
import type { SlackEventService } from "./slack/service.js";
import type { SlackDigestEngine } from "./slack/engine.js";
import type { SlackClient } from "./slack/client.js";
import { setChannelPostHook, setDeliverableHandoffHook } from "./runtime/default.js";
import { getPersonaByAgentMember } from "./db/repositories/personas.js";
import { loadConfig } from "./config/loader.js";
import {
  resolveAgentCollaborationCaps,
  isSpawnEnabledForWorkspace,
} from "./subagents/collaboration.js";
import { setApprovalPendingHook } from "./approvals/pending-hook.js";
import { gitReviewRoutes } from "./routes/git-review.js";
import { turnRoutes } from "./routes/turns.js";
import { createTurnController } from "./turns/default.js";
import type { TurnController } from "./turns/controller.js";
import { autonomyRoutes } from "./routes/autonomy.js";
import { teamRoutes, type CodexSubscriptionStatusProvider } from "./routes/team.js";
import { searchRoutes } from "./routes/search.js";
import { mcpRoutes, type McpRoutesOptions } from "./mcp/http.js";
import { attachRealtime } from "./realtime/gateway.js";
import { createDefaultSessionManager } from "./runtime/default.js";
import { createCodexSubscriptionStatusProvider } from "./runtime/codex-subscription.js";
import {
  createClaudeRuntimeStatusProvider,
  createRuntimeStatusProvider,
  type RuntimeProvider,
  type RuntimeStatusProvider,
} from "./runtime/provider.js";
import { createAgentAuthResolver } from "./runtime/auth-default.js";
import type { SessionManager } from "./runtime/manager.js";
import { runRoutes } from "./routes/run.js";
import { createDefaultRunProcessManager } from "./run/default.js";
import type { RunProcessManager } from "./run/manager.js";
import { startRetentionLoop } from "./retention/default.js";
import { deployRoutes } from "./routes/deploy.js";
import { createDefaultDeployManager } from "./deploy/default.js";
import type { DeployManager } from "./deploy/manager.js";
import { billingRoutes } from "./routes/billing.js";
import { createDefaultBilling } from "./billing/default.js";
import { billingStatus, type BillingStatus } from "./billing/mode.js";
import type { BillingManager } from "./billing/manager.js";
import type { PlanBillingService } from "./billing/plan-service.js";
import type { TrialNurtureService } from "./billing/trial-nurture.js";
import { createGitWorkspaceFromEnv } from "./git/default.js";
import type { GitWorkspaceService } from "./git/workspace.js";
import { GitWorktreeReaper } from "./git/reaper.js";
import { createGitHubProvider } from "./github/factory.js";
import type { GitHubProvider } from "./github/provider.js";
import { createDefaultTeamCoordinator } from "./team/default.js";
import type { TeamCoordinator } from "./team/coordinator.js";
import { createTeamRunStaleSessionReaper } from "./team/stale-session-reaper.js";
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
import { supportRoutes } from "./routes/support.js";
import { SupportDeskService } from "./support/service.js";
import { createDefaultSupportDeskService } from "./support/default.js";
import { legalRoutes } from "./routes/legal.js";
import { createDefaultLegalService } from "./legal/default.js";
import { LegalService } from "./legal/service.js";
import { CustomerVoiceService } from "./voice/service.js";
import { moatRoutes } from "./routes/moat.js";
import { MoatService } from "./moat/service.js";
import { createDefaultMoatService } from "./moat/default.js";
import { getIdeaById, listEvaluations } from "./db/repositories/venture.js";
import type { WatchdogEngine } from "./watchdog/engine.js";
import { createDefaultWatchdogEngine } from "./watchdog/default.js";
import type { SreEngine } from "./sre/engine.js";
import { createDefaultSreEngine } from "./sre/default.js";
import { sreRoutes } from "./routes/sre.js";
import type { SelfHealingEngine } from "./self-healing/engine.js";
import { createDefaultSelfHealingEngine } from "./self-healing/default.js";
import { selfHealingRoutes } from "./routes/self-healing.js";
import { statusRoutes } from "./routes/status.js";
import { reliabilityRoutes } from "./routes/reliability.js";
import type { FlywheelEngine } from "./flywheel/engine.js";
import { createDefaultFlywheelEngine } from "./flywheel/default.js";
import type { SelfQaEngine } from "./selfqa/engine.js";
import { createDefaultSelfQaEngine } from "./selfqa/default.js";
import type { VerifierRunner } from "./verifiers/engine.js";
import { createDefaultVerifierRunner } from "./verifiers/default.js";
import { verifierRoutes } from "./routes/verifiers.js";
import type { VerificationEngine } from "./verification/engine.js";
import { createDefaultVerificationEngine } from "./verification/default.js";
import { verificationRoutes } from "./routes/verification.js";
import { insightRoutes } from "./routes/insights.js";
import { createDefaultInsightMiner, createDefaultInsightEngine } from "./insight/default.js";
import { InsightMiner } from "./insight/service.js";
import type { InsightEngine } from "./insight/engine.js";
import { cloudWorkspaceRoutes } from "./routes/cloud-workspaces.js";
import { createDefaultCloudWorkspaceManager } from "./workspace/default.js";
import { scaleRoutes } from "./routes/scale.js";
import { createScale, type Scale } from "./scale/default.js";
import { founderConsoleRoutes } from "./routes/founder-console.js";
import { customerDeliverableRoutes } from "./routes/customer-deliverables.js";
import { deliverableFeedbackRoutes } from "./routes/deliverable-feedback.js";
import { deliverablePerformanceRoutes } from "./routes/deliverable-performance.js";
import { createDefaultFounderConsoleService } from "./founder-console/default.js";
import type { FounderConsoleService } from "./founder-console/service.js";
import { founderBriefingsRoutes } from "./routes/founder-briefings.js";
import {
  createDefaultFounderBriefingsService,
  createDefaultFounderBriefingsEngine,
} from "./founder-briefings/default.js";
import type { FounderBriefingsService } from "./founder-briefings/service.js";
import type { FounderBriefingsEngine } from "./founder-briefings/engine.js";
import { createDefaultContentCadenceEngine } from "./marketing/content-cadence/default.js";
import type { ContentCadenceEngine } from "./marketing/content-cadence/engine.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { acquisitionRoutes } from "./routes/acquisition.js";
import { createDefaultOnboardingService } from "./onboarding/default.js";
import { createDefaultDnsManager } from "./onboarding/dns/default.js";
import type { DnsManager } from "./onboarding/dns/manager.js";
import type { OnboardingService } from "./onboarding/service.js";
import { realworldRoutes } from "./routes/realworld.js";
import { workspaceCapabilityRoutes } from "./routes/workspace-capabilities.js";
import { hostedRoutes } from "./routes/hosted.js";
import { socialRoutes } from "./routes/social.js";
import { connectionsRoutes } from "./routes/connections.js";
import { imessageRoutes } from "./routes/imessage.js";
import { messagingReadinessRoutes } from "./routes/messaging-readiness.js";
import { telegramRoutes } from "./routes/telegram.js";
import { whatsappRoutes } from "./routes/whatsapp.js";
import { createInboundTeamLaunchService } from "./messaging/inbound-team-launch.js";
import { gardenRoutes } from "./routes/garden.js";
import { skilloptRoutes } from "./routes/skillopt.js";
import { agentToolRoutes } from "./routes/agent-tools.js";
import { departmentRoutes } from "./routes/department.js";
import { brandKitRoutes } from "./routes/brand-kit.js";
import { brandVoiceRoutes } from "./routes/brand-voice.js";
import { createDefaultRealworldActuatorService } from "./realworld/default.js";
import type { RealWorldActuatorService } from "./realworld/service.js";
import { financeRoutes } from "./routes/finance.js";
import { createDefaultFinanceService, createDefaultFinanceEngine } from "./finance/default.js";
import { budgetRoutes } from "./routes/budget.js";
import { attributionRoutes } from "./routes/attribution.js";
import { customerIdentityRoutes } from "./routes/customer-identity.js";
import type { FinanceService } from "./finance/service.js";
import type { FinanceLedgerEngine } from "./finance/engine.js";
import {
  createDefaultMonetizationService,
  createDefaultMonetizationEngine,
} from "./monetization/default.js";
import type { MonetizationService } from "./monetization/service.js";
import type { MonetizationEngine } from "./monetization/engine.js";
import { growthRoutes } from "./routes/growth.js";
import { createDefaultGrowthService } from "./growth/default.js";
import { attributionMetadata, type SignupAttribution } from "./attribution/signup.js";
import { createDefaultReferralService } from "./referrals/default.js";
import type { ReferralService } from "./referrals/service.js";
import { decisionMakerRoutes } from "./routes/decision-maker.js";
import { createDefaultDecisionMakerService } from "./decision-maker/default.js";
import type { DecisionMakerService } from "./decision-maker/service.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { createDefaultDiscoveryService } from "./discovery/default.js";
import type { DiscoveryService } from "./discovery/service.js";
import { inboundLeadsRoutes } from "./routes/inbound-leads.js";
import {
  createDefaultInboundLeadConfirmationSender,
  createDefaultInboundLeadFollowup,
  resolveInboundLeadsOwnerWorkspaceId,
} from "./leads/default.js";
import { outreachRoutes } from "./routes/outreach.js";
import { reachRoutes } from "./routes/reach.js";
import { intentScannerRoutes } from "./routes/intent-scanner.js";
import { createDefaultIntentScannerService } from "./intent-scanner/default.js";
import type { IntentScannerService } from "./intent-scanner/service.js";
import { createDefaultReachService } from "./reach/default.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { workspaceContextRoutes } from "./routes/workspace-context.js";
import { marketingTargetRoutes } from "./routes/marketing-target.js";
import { provisioningRoutes } from "./routes/provisioning.js";
import { createIMessageRelayService } from "./imessage/default.js";
import type { IMessageRelayService } from "./imessage/service.js";
import { createTelegramRoomService } from "./telegram/default.js";
import type { TelegramRoomService } from "./telegram/service.js";
import { createWhatsAppRoomService } from "./whatsapp/default.js";
import type { WhatsAppRoomService } from "./whatsapp/service.js";
import { createDefaultProvisioningService } from "./provisioning/default.js";
import { adsRoutes } from "./routes/ads.js";
import { createDefaultAdsService } from "./ads/default.js";
import { enterpriseRoutes } from "./routes/enterprise.js";
import { createDefaultEnterpriseService, enterpriseCapsFor } from "./enterprise/default.js";
import { createEnterprisePassportHook } from "./enterprise/passport-gate.js";
import { seoRoutes } from "./routes/seo.js";
import { createDefaultSeoRankService } from "./seo/default.js";
import { searchConsoleRoutes } from "./routes/search-console.js";
import { createDefaultSearchConsoleService } from "./search-console/default.js";
import { createDefaultOutreachService } from "./outreach/default.js";
import type { OutreachService } from "./outreach/service.js";
import { semanticRoutes } from "./routes/semantic.js";
import { createDefaultSemanticLayerService } from "./semantic/default.js";
import type { SemanticLayerService } from "./semantic/service.js";
import { evalRoutes } from "./routes/evals.js";
import { createDefaultEvalService } from "./evals/default.js";
import type { EvalService } from "./evals/service.js";
import type { GrowthService } from "./growth/service.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { createDefaultPortfolioService } from "./portfolio/default.js";
import type { PortfolioService } from "./portfolio/service.js";
import { planningRoutes } from "./routes/planning.js";
import { createDefaultPlanningService } from "./planning/default.js";
import type { PlanningService } from "./planning/service.js";
import { createDefaultVentureMemoryService } from "./venture-memory/default.js";
import {
  createDefaultVentureFactoryEngine,
  createDefaultVentureFactoryService,
} from "./venture-factory/default.js";
import { createDefaultCadenceEngine } from "./cadence/default.js";
import { createDefaultSkillOptEngine } from "./skillopt/default.js";
import type { VentureFactoryEngine } from "./venture-factory/engine.js";
import type { CadenceEngine } from "./cadence/engine.js";
import type { SkillOptEngine } from "./skillopt/engine.js";
import type { VentureMemoryService } from "./venture-memory/service.js";
import { ventureMemoryRoutes } from "./routes/venture-memory.js";
import { ventureFactoryRoutes } from "./routes/venture-factory.js";
import { buildLoopRoutes } from "./routes/build-loop.js";
import { createDefaultBuildLoopEngine } from "./build-loop/default.js";
import {
  createDefaultVentureDeployProvisioner,
  createDefaultVentureReleasePipeline,
} from "./venture-deploy/default.js";
import { releasePipelineAsPostMergeVerifier } from "./venture-deploy/release.js";
import type { BuildLoopEngine } from "./build-loop/engine.js";
import { automationRoutes } from "./routes/automations.js";
import { createDefaultAutomationEngine } from "./automations/default.js";
import { automationStore } from "./db/repositories/automations.js";
import type { AutomationEngine } from "./automations/engine.js";
import { catalogRoutes } from "./routes/catalog.js";
import { workflowRoutes } from "./routes/workflows.js";
import { createDefaultWorkflowEngine } from "./workflows/default.js";
import { dependencySchedulerRoutes } from "./routes/dependency-scheduler.js";
import { createDefaultDependencySchedulerService } from "./dependency-scheduler/default.js";
import { createDefaultScheduler } from "./scheduler/default.js";
import type { DurableScheduler } from "./scheduler/scheduler.js";
import { workflowStore } from "./db/repositories/workflows.js";
import type { WorkflowEngine } from "./workflows/engine.js";
import type { DependencySchedulerService } from "./dependency-scheduler/service.js";
import { missionControlRoutes } from "./routes/mission-control.js";
import { createDefaultMissionControlService } from "./mission-control/default.js";
import type { MissionControlService } from "./mission-control/service.js";
import { auditRoutes } from "./routes/audit.js";
import { createDefaultAuditService } from "./audit/default.js";
import type { AuditService } from "./audit/service.js";
import { createDefaultGatePricingService } from "./gate-pricing/default.js";
import type { GatePricingService } from "./gate-pricing/service.js";
import { AdmissionError } from "./scale/admission.js";
import { SpendCapBreachError } from "./runtime/manager.js";
import { recordAdmissionDenied } from "./observability/metrics.js";

/**
 * The `Retry-After` (seconds) advertised on a 429 admission denial (#221). A capacity hold frees as
 * in-flight sessions finish, so a short hint is right — long enough that an immediate re-tap doesn't just
 * re-hit the cap, short enough that the founder isn't told to wait minutes for a slot that clears in seconds.
 */
const ADMISSION_RETRY_AFTER_SECONDS = 30;
import type { SaturationCollectorDeps } from "./observability/saturation.js";
import { getPool } from "./db/index.js";
import { getRedis } from "./redis/index.js";
import type { CloudWorkspaceManager } from "./workspace/manager.js";

declare module "fastify" {
  interface FastifyInstance {
    /** The #17 autonomy engine; `index.ts` starts its opt-in background timer. */
    autonomyEngine: AutonomyEngine;
    /** The #951 approval-expiry sweeper; `index.ts` starts its opt-in background timer. */
    approvalExpiryEngine: ApprovalExpiryEngine;
    /** The #960 expired human-session cleanup loop; `index.ts` starts its background timer. */
    authSessionCleanupEngine: AuthSessionCleanupEngine;
    /** The #96 venture engine; `index.ts` starts its opt-in background tick (VENTURE_INTERVAL_MS). */
    ventureEngine: VentureEngine;
    /** The #105 fleet watchdog; `index.ts` starts its opt-in supervisor tick (WATCHDOG_INTERVAL_MS). */
    watchdogEngine: WatchdogEngine;
    /** The #112 SRE on-call loop; `index.ts` starts its opt-in tick (SRE_INTERVAL_MS). */
    sreEngine: SreEngine;
    /** The #193 self-healing ops loop; `index.ts` starts its opt-in tick (SELF_HEALING_INTERVAL_MS). */
    selfHealingEngine: SelfHealingEngine;
    /** The #119 evidence pricer; config default-OFF, driven per-workspace via `tick(workspaceId)`. */
    gatePricingService: GatePricingService;
    /** The #117 self-healing flywheel; `index.ts` starts its opt-in tick (FLYWHEEL_INTERVAL_MS). */
    flywheelEngine: FlywheelEngine;
    /** The #171 self-QA loop; `index.ts` starts its opt-in tick (SELFQA_INTERVAL_MS). */
    selfqaEngine: SelfQaEngine;
    /** The #106 outcome-verifier runner; `index.ts` starts its opt-in tick (VERIFIERS_INTERVAL_MS). */
    verifierRunner: VerifierRunner;
    /** The #191 deliverable verification layer; invoked at deliverable chokepoints (default-OFF). */
    verificationEngine: VerificationEngine;
    /** The #100 insight miner; `index.ts` starts its opt-in mining tick (INSIGHT_INTERVAL_MS). */
    insightEngine: InsightEngine;
    /** The #115 product planning loop; `index.ts` starts its opt-in tick (PLANNING_INTERVAL_MS). */
    planningEngine: PlanningService;
    /** The #197 venture memory & planning loop; `index.ts` starts its weekly tick (VENTURE_PLANNING_INTERVAL_MS). */
    ventureMemoryEngine: VentureMemoryService;
    /** The #187 venture factory scanner; `index.ts` starts its opt-in tick (VENTURE_FACTORY_INTERVAL_MS). */
    ventureFactoryEngine: VentureFactoryEngine;
    /** The #416 autonomous work cadence; `index.ts` starts its opt-in tick (RELOAD_CADENCE_INTERVAL_MS). */
    cadenceEngine: CadenceEngine;
    /** The #283 SkillOpt-Sleep loop; `index.ts` starts its opt-in tick (RELOAD_SKILLOPT_INTERVAL_MS). */
    skilloptEngine: SkillOptEngine;
    /** The #172 self-shipping loop; `index.ts` starts its opt-in tick (BUILDLOOP_INTERVAL_MS). */
    buildLoopEngine: BuildLoopEngine;
    /** The #173 founder briefings engine; `index.ts` starts its opt-in tick (BRIEFINGS_INTERVAL_MS). */
    founderBriefingsEngine: FounderBriefingsEngine;
    contentCadenceEngine: ContentCadenceEngine;
    /** The #194 finance ledger engine; `index.ts` starts its opt-in tick (FINANCE_INTERVAL_MS). */
    financeEngine: FinanceLedgerEngine;
    /** The #188 monetization engine; `index.ts` starts its opt-in tick (MONETIZATION_INTERVAL_MS). */
    monetizationEngine: MonetizationEngine;
    /** The #147 automations engine; `index.ts` starts its opt-in tick (AUTOMATIONS_INTERVAL_MS). */
    automationEngine: AutomationEngine;
    /** The #152 workflow engine; `index.ts` starts its opt-in tick (WORKFLOWS_INTERVAL_MS). */
    workflowEngine: WorkflowEngine;
    /**
     * The #559 durable, single-leader scheduler. `index.ts` registers each restart-safe engine tick
     * (planning / venture-memory / verifiers / workflows) and calls `start()`; stopped on server close.
     */
    scheduler: DurableScheduler;
    /** The #170 Slack digest engine; `index.ts` starts its opt-in tick (SLACK_DIGEST_INTERVAL_MS). */
    slackDigestEngine: SlackDigestEngine;
    /** The #1548 always-on Reddit/X buying-intent scanner; index.ts registers its opt-in durable tick. */
    intentScannerService: IntentScannerService;
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
  /** #607 Trial nurture: tests inject a deterministic service; default builds one with billing. */
  trialNurture?: TrialNurtureService;
  /** #481 Go-live: override the billing status (provider/mode/live) the status route reports; default from env. */
  billingStatus?: BillingStatus;
  /** Tests inject an AutonomyEngine and drive `tick()` deterministically (#17). */
  autonomyEngine?: AutonomyEngine;
  /** Tests inject an approval-expiry sweeper and drive `tickAll()` deterministically (#951). */
  approvalExpiryEngine?: ApprovalExpiryEngine;
  /** Tests inject an auth-session cleanup engine and drive `tick()` deterministically (#960). */
  authSessionCleanupEngine?: AuthSessionCleanupEngine;
  /** Tests inject a TeamCoordinator over a fake-runtime SessionManager (Team Mode). */
  teamCoordinator?: TeamCoordinator;
  /** #1282 Codex subscription status gate: tests inject deterministic status; default probes Codex doctor. */
  codexSubscription?: CodexSubscriptionStatusProvider;
  /** #1568 provider-agnostic runtime readiness: tests inject deterministic status; default derives from the provider. */
  runtimeStatus?: RuntimeStatusProvider;
  /** #1568 runtime provider override: tests pin `codex` to exercise the legacy posture; default env-resolved. */
  runtimeProvider?: RuntimeProvider;
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
  /** #190 support desk: tests inject one service (shared by routes + #104 SLA pane). Default-OFF autonomy. */
  supportDesk?: SupportDeskService;
  /** #196 legal & compliance pack: tests inject one service over fakes; default builds the real one. */
  legal?: LegalService;
  /** #103 moat accrual: tests inject a service over a fake ledger; default builds the real one. */
  moat?: MoatService;
  /** #105 fleet watchdog: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  watchdog?: WatchdogEngine;
  /** #112 SRE loop: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  sre?: SreEngine;
  /** #193 self-healing ops: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  selfHealing?: SelfHealingEngine;
  /** #117 self-healing flywheel: tests inject an engine and drive `record`/`tickWorkspace()`. */
  flywheel?: FlywheelEngine;
  /** #171 self-QA loop: tests inject an engine and drive `runOnce()`. */
  selfqa?: SelfQaEngine;
  /** #106 outcome verifiers: tests inject a runner and drive `verify`/`tickWorkspace()`; default builds the real one. */
  verifiers?: VerifierRunner;
  /** #191 verification layer: tests inject an engine and drive `defineDone`/`verify`; default builds the real one. */
  verification?: VerificationEngine;
  /** #100 insight miner: tests inject a miner over a deterministic stub; default builds the real one. */
  insight?: InsightMiner;
  /**
   * #104 founder console: tests inject a read-only aggregation service over fakes; default builds one
   * over the SAME live `scale` + `billingManager` so its fleet/budget/revenue match what they enforce.
   */
  founderConsole?: FounderConsoleService;
  /**
   * #222 customer discovery engine: tests inject a service over fakes; default builds one over the real
   * `discovery_*` repos + the live growth bridge. Read-only — ranks/surfaces, never sends.
   */
  discovery?: DiscoveryService;
  /**
   * GAP 1 leads centre (ADR-0400): the workspace a public landing lead is attributed to. Tests inject a
   * concrete id to exercise the public `POST /inbound/leads` capture; default resolves the marketing-owner
   * workspace from config (`marketing.ownerWorkspaceId`). Unset ⇒ the public route 503s.
   */
  inboundLeadsOwnerWorkspaceId?: string;
  /**
   * #173 founder briefings: tests inject a service over reader fakes; default builds one over the SAME
   * live `scale`/`billing`/`portfolio` so the brief/report/decision-queue match what they enforce.
   */
  founderBriefings?: FounderBriefingsService;
  /** #173 founder briefings engine: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  founderBriefingsEngine?: FounderBriefingsEngine;
  contentCadenceEngine?: ContentCadenceEngine;
  /** #192 external account onboarding: tests inject a service over fakes (incl. a fake DNS provider); default wires the real repos. */
  onboarding?: OnboardingService;
  /** #264 DNS automation: tests inject a manager over a fake provider + receipt sink; default wires the real repos. */
  dnsManager?: DnsManager;
  /** #231 real-world tool surface: tests inject a service over fakes; default wires the real repos + the dry-run publisher. */
  realworld?: RealWorldActuatorService;
  /** #194 finance ledger: tests inject a service over store/reader fakes; default wires the real repos. */
  finance?: FinanceService;
  /** #194 finance ledger engine: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  financeEngine?: FinanceLedgerEngine;
  /** #188 monetization: tests inject a service over fakes; default wires the real repos/vault/provider. */
  monetization?: MonetizationService;
  /** #188 monetization engine: tests inject an engine and drive `tickWorkspace()`; default builds the real one. */
  monetizationEngine?: MonetizationEngine;
  /** #119 evidence-priced autonomy: tests inject a pricer and drive `tick()`; default builds the real one. */
  gatePricing?: GatePricingService;
  /** #102 growth loop: tests inject a service over fakes; default builds the real repo-backed one. */
  growth?: GrowthService;
  /** #603 referral loop: tests inject a service; default stores signup attribution and incentives in Postgres. */
  referrals?: ReferralService;
  /** #223 decision-maker resolver: tests inject a service over fakes; default builds the real one. */
  decisionMaker?: DecisionMakerService;
  /** #225 outreach engine: tests inject a service over fakes; default builds the real repo-backed one. */
  outreach?: OutreachService;
  /** #1548 buying-intent scanner: tests inject fakes; default stores leads and uses the connector seam. */
  intentScanner?: IntentScannerService;
  /** #107 portfolio lifecycle loop: tests inject a service over fakes; default reads the live moat/
   * growth/demand/billing surfaces. */
  portfolio?: PortfolioService;
  /** #115 product planning loop: tests inject a service over a fake launcher; default builds the real one. */
  planning?: PlanningService;
  /** #197 venture memory & planning: tests inject a service over fakes; default builds the real repo-backed one. */
  ventureMemory?: VentureMemoryService;
  /** #172 self-shipping loop: tests inject an engine over a fake repo host; default builds the real one. */
  buildLoop?: BuildLoopEngine;
  /** #147 automations: tests inject an engine over a fake launcher; default builds the real repo-backed one. */
  automations?: AutomationEngine;
  /** #152 workflows: tests inject an engine over fake action seams; default builds the real repo-backed one. */
  workflows?: WorkflowEngine;
  /** #590 dependency-aware scheduler: tests inject a service; default builds the self-managed Postgres-backed one. */
  dependencyScheduler?: DependencySchedulerService;
  /** #559 scheduler: tests inject a scheduler over an in-memory store; default builds the Postgres-backed one. */
  scheduler?: DurableScheduler;
  /** #147 mission control: tests inject a read-only service over fakes; default reads the live #25 sessions. */
  missionControl?: MissionControlService;
  /** #147 audit trail: tests inject a read-only service over fakes; default reads existing append-only rows. */
  audit?: AuditService;
  /** #155 semantic layer: tests inject a service over a fake resolver; default reads the governed summaries. */
  semantic?: SemanticLayerService;
  /** #155 eval-gated maintenance: tests inject a service over fakes; default wires the flywheel feed. */
  evals?: EvalService;
  /** #153 marketing-site CMS-lite: tests inject an in-memory ContentSource; default reads repo markdown. */
  contentSource?: ContentSource;
  /** #170 Slack-native: tests inject a fully-built service over fakes; default wires the real bridge. */
  slack?: SlackEventService;
  /** #170 Slack-native: tests inject a recording SlackClient so no real Slack call leaves the box. */
  slackClient?: SlackClient;
  /**
   * #260 non-technical onboarding (domain + "Sign in with Google"). Tests inject a fake Google client +
   * config + recording bootstrap so the flow runs without network. Default reads Google config from env
   * (feature off until configured) and builds the real bootstrap over the shared SessionManager.
   */
  googleAuth?: GoogleAuthRoutesOptions;
  /**
   * #262 in-app Connect Claude. Tests inject a connect provider so the flow runs without network. Default
   * derives it from env (dry-run unless a live `CLAUDE_OAUTH_*` client is configured), so the one-click
   * flow stays an honest `coming_soon` until wired.
   */
  claudeConnect?: ClaudeConnectRoutesOptions;
  /** #1283 iMessage room: tests inject a fake relay service; default uses the macOS Messages adapter. */
  imessage?: IMessageRelayService;
  /** #1283 iMessage inbound relay: tests inject a secret; production reads IMESSAGE_RELAY_WEBHOOK_SECRET. */
  imessageWebhookSecret?: string;
  /** #1267 Telegram room bridge: tests inject a fake bot service; default reads TELEGRAM_* env. */
  telegram?: TelegramRoomService;
  /** #1267 WhatsApp room bridge: tests inject a fake Cloud API service; default reads WHATSAPP_* env. */
  whatsapp?: WhatsAppRoomService;
  /**
   * #300 low-commitment front door. Tests inject `signupEntry` caps so the read-only sample workspace can
   * be exercised without a config file. Default reads the layered config (sample workspace OFF).
   */
  sample?: SampleRoutesOptions;
  /** #388 computer-use bridge: tests/production bootstrap may opt MCP into browser tools. Default OFF. */
  browser?: McpRoutesOptions["browser"];
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const env = loadEnv();
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['set-cookie']",
          "req.body.password",
          "req.body.token",
          "req.body.secret",
          "req.body.apiKey",
          "req.query.token",
          "req.query.secret",
          "req.query.apiKey",
        ],
        censor: REDACTION_MASK,
      },
    },
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: () => newId(),
  });
  app.register(cookie);
  registerPublicRateLimits(app);
  // #108: env-gated CORS so the Vercel-hosted console (https://ipop.ai) can make credentialed calls
  // to this API on a different origin (https://api.ipop.ai). No-op unless RELOAD_WEB_ORIGIN is set.
  registerCors(app);
  // #71 cloud scale: ONE Admission instance (kill switch, budget, concurrency caps, region placement)
  // shared between the SessionManager (which mutates its counters) and the usage/founder-console/metrics
  // readers. Built here (before observability) so the #113 saturation sampler can read its global
  // in-flight count as the scrape-time queue-depth signal. When managed config sets no global cap,
  // admission falls back to TEAM_MAX_CONCURRENCY so parallel local/demo runs cannot stampede the host.
  const scale = opts.scale ?? createScale(env.team.maxConcurrency);
  const retentionLoop = startRetentionLoop({ logger: app.log });
  app.addHook("onClose", async () => {
    retentionLoop.stop();
  });
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
  // Other uncaught errors are logged with the request id and sanitized before crossing the HTTP boundary.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AdmissionError) {
      recordAdmissionDenied(err.reason);
      const status = err.reason === "budget_exceeded" || err.reason === "plan_expired" ? 402 : 429;
      // #221: a 429 (capacity / kill switch) carries a `Retry-After` so the client can show an honest
      // "retry in Ns" and hold the retry control until then, instead of re-firing straight into the cap.
      // Additive metadata only — the denial itself is unchanged (no gate is weakened).
      if (status === 429) reply.header("retry-after", String(ADMISSION_RETRY_AFTER_SECONDS));
      return reply.code(status).send({
        error: err.message,
        reason: err.reason,
        ...(err.reason === "budget_exceeded" || err.reason === "plan_expired"
          ? { upgradePath: "Open Billing settings to raise or upgrade the workspace session budget." }
          : {}),
      });
    }
    if (err instanceof SpendCapBreachError) {
      return reply.code(402).send({
        error: err.message,
        reason: err.reason,
        approvalRequestId: err.approvalRequestId,
        requestCents: err.requestCents,
      });
    }
    // #96: the venture admission gate denies an autonomy launch lacking a fundable scorecard → 403.
    if (err instanceof VentureAdmissionError) {
      return reply.code(403).send({ error: err.message, reason: err.reason });
    }
    // Client errors (schema-validation 400, 404, etc.) carry an explicit sub-500 status. Pass them
    // through unchanged — sanitizing them into a 500 would wrongly mask a caller mistake as a server fault.
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode < 500) {
      return reply.send(err);
    }
    req.log.error({ err, requestId: req.id }, "unhandled request error");
    return reply
      .header("x-request-id", req.id)
      .code(500)
      .send({ error: "internal_error", requestId: req.id });
  });
  app.register(healthRoutes);
  // #153 public marketing-site content API (CMS-lite over repo markdown) — unauthenticated, published-only.
  app.register(siteRoutes, { contentSource: opts.contentSource });
  // #461 public dogfood feed: unauthenticated but explicit opt-in by workspace slug, with a second public
  // projection over already-redacted trace receipts. Unset PUBLIC_DOGFOOD_SLUGS => 404 for every slug.
  app.register(publicDogfoodRoutes, {
    enabledSlugs: env.publicDogfood.enabledSlugs,
    limit: env.publicDogfood.limit,
  });
  // #300 low-commitment front door: the read-only sample workspace (unauthenticated, read-only). Default
  // OFF — answers `{ offered: false }` until the deployment turns on `signupEntry.sampleWorkspace`.
  app.register(sampleRoutes, { ...opts.sample });
  // #99 maintenance control: GET/POST /maintenance backs `reload maintenance on|off|status`.
  app.register(maintenanceRoutes);
  // #123/#902 signup auto-seed needs the SessionManager (welcome launches when enabled), so authRoutes is registered
  // below, right after the manager is built.
  app.register(meRoutes);
  // #262 in-app one-click Connect Claude (replaces the `claude setup-token` CLI; default OFF, owner-first).
  app.register(claudeConnectRoutes, { ...opts.claudeConnect });
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
  app.register(decisionsRoutes);
  app.register(tracesRoutes);
  app.register(budgetRoutes);
  app.register(taskRoutes);
  // #191/#853 deliverable verification layer: construct it before the approval registry so the real
  // post-approval delivery chokepoint can fail closed when no passing verdict exists.
  const verificationEngine = opts.verification ?? createDefaultVerificationEngine(app.log);
  app.decorate("verificationEngine", verificationEngine);
  // #13 human approval gates: agents submit sensitive actions; humans approve (→ execute) or reject.
  // #189: the executor registry routes approved `external.send` actions through the acquisition
  // dispatcher so an approved ads/email/social/SEO campaign actually runs. Default-OFF: with the
  // acquisition flag off (the default) the dispatcher returns null and the executor stays recorded-only.
  app.register(approvalRoutes, { registry: buildAcquisitionRegistry(verificationEngine) });
  const approvalExpiryEngine =
    opts.approvalExpiryEngine ?? createDefaultApprovalExpiryEngine(app.log);
  app.addHook("onClose", async () => {
    approvalExpiryEngine.stop();
  });
  app.decorate("approvalExpiryEngine", approvalExpiryEngine);
  // #151 governance & trust: workspace roles (owner/approver/viewer), email invites, egress report.
  app.register(governanceRoutes);
  app.register(searchRoutes);
  // #10 MCP integration: a stateful Streamable-HTTP MCP server at /mcp. Each tool/resource is a
  // thin adapter over the existing repos + access helpers (no new authority); auth is the existing
  // agent Bearer token (#3) checked per request, and resource subscriptions bridge onto the #5 bus.
  app.register(mcpRoutes, { browser: opts.browser });
  // #25 cloud agent execution: the SessionManager owns the agent run server-side (close the
  // laptop, agents keep working). Default backend is `local`; tests may inject a fake-runtime
  // manager. It is cancelled+drained on server close so no run leaks past shutdown.
  // #71 cloud scale: the SessionManager mutates the SAME `scale.admission` counters built above (so the
  // usage route + #113 saturation queue-depth read what the manager runs). With all caps 0 (the
  // default) it admits everything — unchanged #25 behavior — but enables kill-switch-halts-launch + usage.
  const sessionManager = opts.sessionManager ?? createDefaultSessionManager(app.log, scale);
  const teamCoordinator =
    opts.teamCoordinator ?? createDefaultTeamCoordinator(app.log, sessionManager);
  const codexSubscription = opts.codexSubscription ?? createCodexSubscriptionStatusProvider();
  // #1568 runtime provider: the fleet executes on Claude by default (AGENT_RUNTIME_PROVIDER=codex
  // restores the legacy posture). Readiness derives from the SAME AgentAuthResolver the launch
  // secrets path uses — subscription first (workspace connect or the deployment env
  // CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), ANTHROPIC_API_KEY as optional fallback —
  // so the status and the launch can never disagree. Modes only; values never leave the secrets path.
  const runtimeProvider = opts.runtimeProvider ?? env.agent.provider;
  const statusAuthResolver = createAgentAuthResolver();
  const claudeRuntimeStatus = createClaudeRuntimeStatusProvider({
    resolveAuthMode: async (workspaceId) => {
      const auth = await statusAuthResolver.resolve(workspaceId);
      // Thread the loud plain-language cause (e.g. malformed workspace token) into the status.
      return auth.mode === "none"
        ? { mode: auth.mode, ...(auth.reason ? { reason: auth.reason } : {}) }
        : { mode: auth.mode };
    },
  });
  const runtimeStatus =
    opts.runtimeStatus ??
    createRuntimeStatusProvider(runtimeProvider, {
      claude: claudeRuntimeStatus,
      codex: codexSubscription,
    });
  const imessageService = opts.imessage ?? createIMessageRelayService(env.imessage);
  const telegramService = opts.telegram ?? createTelegramRoomService(env.telegram);
  const whatsappService = opts.whatsapp ?? createWhatsAppRoomService(env.whatsapp);
  setExternalRoomMirror(
    createExternalRoomMirror({
      telegram: telegramService,
      whatsapp: whatsappService,
      log: app.log,
    }),
  );
  setIMessageRoomMirror(createIMessageRoomMirror({ log: app.log }));
  const inboundTeamLaunch = createInboundTeamLaunchService({
    sessionManager,
    coordinator: teamCoordinator,
    runtimeStatus,
    runtimeProvider,
  });
  app.register(agentSessionRoutes, { sessionManager });
  app.register(scaleRoutes, { admission: scale.admission, config: scale.config, activePlans: scale.activePlans });
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
  // #901 signup attribution: construct growth before auth/OAuth so both entry points can record the
  // acquisition denominator without waiting for the growth routes to be registered.
  const growthService = opts.growth ?? createDefaultGrowthService();
  const referralService = opts.referrals ?? createDefaultReferralService();
  // #222 customer discovery engine: one instance shared by signup, billing, outreach, and the console.
  const discoveryService =
    opts.discovery ?? createDefaultDiscoveryService({ growth: growthService });
  // #101/#125/#607/#602 billing + lifecycle services are shared by signup, billing routes, and webhook
  // activation so a trial signup can enter the nurture sequence before the owner opens the billing panel.
  const demandService = opts.demand ?? createDefaultDemandService(app.log);
  const billingDefaults =
    !opts.billingManager || !opts.planService || !opts.trialNurture
      ? createDefaultBilling(app.log, demandService, {
          funnel: {
            advancePostSales: (input) =>
              discoveryService.advancePipelineStage(input.workspaceId, {
                prospectKey: input.prospectKey,
                stage: "post_sales",
                externalRef: input.externalRef,
              }),
          },
        })
      : null;
  const billingManager = opts.billingManager ?? billingDefaults!.billingManager;
  const planService = opts.planService ?? billingDefaults!.planService;
  const trialNurture = opts.trialNurture ?? billingDefaults!.trialNurture;
  // #481 go-live status: from env by default; tests injecting a manager can override (else test/none).
  const billingStatusValue =
    opts.billingStatus ?? billingDefaults?.status ?? billingStatus("none", "test");
  // #123 marketing department fleet: seed a workspace into a working agency (a channel + a named agent
  // per marketing function), turn an @mention into a REAL harness session through the venture-gated
  // launcher (kill-switch + tenant-budget aware), and expose the team panel + its task records. External
  // sends stay #13-gated, sensitive-by-default. authRoutes is registered here too so signup can
  // auto-seed (config default-OFF) through the SAME SessionManager.
  app.register(authRoutes, {
    onWorkspaceCreated: async (
      workspaceId: string,
      ownerMemberId: string,
      attribution: SignupAttribution,
    ) => {
      await Promise.allSettled([
        maybeAutoSeedOnSignup(sessionManager, workspaceId, ownerMemberId, app.log),
        growthService.recordEvent(workspaceId, {
          kind: "acquisition",
          source: attribution.source,
          metadata: attributionMetadata(attribution),
        }),
        referralService.ensureWorkspaceReferralCode(workspaceId, ownerMemberId),
        referralService.attributeSignup({
          referralCode: attribution.referralCode,
          referredWorkspaceId: workspaceId,
          referredMemberId: ownerMemberId,
          trackingRef: attribution.trackingRef,
        }),
        trialNurture.enrollSignup(workspaceId, ownerMemberId, { source: "auth.signup" }),
        ...(attribution.trackingRef
          ? [
              discoveryService.advancePipelineStage(workspaceId, {
                prospectKey: attribution.trackingRef,
                stage: "onboarding",
                externalRef: `signup:${ownerMemberId}`,
              }),
            ]
          : []),
      ]);
    },
  });
  const authSessionCleanupEngine =
    opts.authSessionCleanupEngine ?? createDefaultAuthSessionCleanupEngine(app.log);
  app.addHook("onClose", async () => {
    authSessionCleanupEngine.stop();
  });
  app.decorate("authSessionCleanupEngine", authSessionCleanupEngine);
  // #260 non-technical onboarding: the single Google consent (identity + Search Console + Analytics) →
  // create/attach the workspace, seal the connection, kick Scout to verify the domain + submit the sitemap,
  // land on the board. Default reads Google config from env (off until configured) and builds the real
  // bootstrap over THIS SessionManager; tests inject a fake client + recording bootstrap.
  app.register(googleAuthRoutes, { sessionManager, growth: growthService, ...opts.googleAuth });
  app.register(marketingRoutes, { sessionManager });
  // #282 agent registry + A2A: list the fleet's declared contracts and run governed, observable
  // agent-to-agent calls. Default OFF + owner-workspace-first; the call route reuses the marketing
  // launch seam (no new authority). Read catalog at GET /workspaces/:wid/agents.
  app.register(agentRegistryRoutes, { sessionManager });
  // #123 prod-incident fix: wire the @mention → real-session trigger into the SHARED message fan-out
  // (`messaging/delivery.ts`), so a plain `@scout …` post in a department channel launches a session
  // over REST or MCP — without this, the launch only ran via the unused `/marketing` endpoint and a
  // real @mention silently did nothing (sessionsStarted stayed 0). The trigger gates itself (human
  // author, marketing channel, mentioned persona) and runs best-effort over the SAME SessionManager.
  setMarketingMentionTrigger(
    buildMarketingMentionTrigger(sessionManager, app.log, {
      // GAP-1 path C (owner-first, default-off via `marketing.launchRoomBrief`): a plain brief posted to the
      // room's general channel with no @mention starts a threaded team-run on that exact text — reusing the
      // same coordinator/runtime the everyday + inbound-bridge launches use.
      launch: createRoomBriefLauncher({
        sessionManager,
        coordinator: teamCoordinator,
        runtimeStatus,
        runtimeProvider,
        logger: app.log,
      }),
    }),
  );
  // #417 visible governed handoffs: when an agent's deliverable @mentions a fleet teammate, launch that
  // teammate through the EXISTING governed a2a path (depth/cycle/capability-bounded by `decideA2ACall`)
  // and visibly narrate it in-channel via the #370 bridge. Wired here AFTER both the SessionManager and
  // the registry service exist (mirrors `setMarketingMentionTrigger` / `setChannelPostHook`, breaking the
  // manager↔service cycle). Gated by the EXISTING `agentCollaboration` capability (#319, default-OFF,
  // owner-workspace-first): with it off the hook is a no-op and behavior is byte-for-byte unchanged.
  const agentRegistryService = createAgentRegistryService(sessionManager);
  // #513 shared memory: capture the agent's decisions from its posted deliverable into the shared store so a
  // teammate reuses them without being re-told. Internal memory write only (no send/spend), isolated from
  // the a2a handoff below — a capture error never blocks the handoff. Built once; the SessionManager hook
  // already only fires when a deliverable is actually posted (the #370 owner-first posting gate).
  const decisionService = createDefaultDecisionService();
  setDeliverableHandoffHook(async ({ workspaceId, agentMemberId, task, deliverable }) => {
    try {
      const recorded = await captureDecisionsFromDeliverable(decisionService, {
        workspaceId,
        agentMemberId,
        task,
        deliverable,
      });
      if (recorded > 0) {
        app.log.info({ workspaceId, agentMemberId, recorded }, "decision capture: recorded");
      }
    } catch (err) {
      app.log.warn({ workspaceId, agentMemberId, err: String(err) }, "decision capture: skipped");
    }
    const collab = resolveAgentCollaborationCaps(loadConfig(workspaceId).agentCollaboration);
    if (!isSpawnEnabledForWorkspace(collab, workspaceId)) {
      app.log.info(
        { workspaceId, agentMemberId, reason: "collaboration-disabled" },
        "handoff hook: skipped",
      );
      return;
    }
    // Resolve the caller's @handle from its member id (a persona's `name` IS its fleet @handle).
    const persona = await getPersonaByAgentMember(workspaceId, agentMemberId);
    const callerHandle = persona?.name;
    if (!callerHandle) {
      app.log.warn(
        { workspaceId, agentMemberId, reason: "no-caller-handle" },
        "handoff hook: skipped",
      );
      return;
    }
    // The chain marker is OUR structural prefix on the task WE assigned the caller's session (#200) — read
    // it back to keep the depth/cycle guard accurate across hops; absent ⇒ this is the first hop.
    const callChain = parseHandoffChain(task);
    // Observable on purpose (#417): a deliverable handoff must never be a silent no-op. The result explains
    // WHY there were no launches (no fleet @mention / empty registry) or each launch outcome (denied+reason
    // or dispatched), so operators can see the team actually handing off — or exactly why it didn't.
    const result = await agentRegistryService.handoffsFromDeliverable(
      { workspaceId, memberId: agentMemberId },
      { callerHandle, deliverable, callChain },
    );
    app.log.info(
      {
        workspaceId,
        callerHandle,
        callChain,
        knownHandleCount: result.knownHandleCount,
        mentions: result.mentions,
        attempts: result.attempts,
      },
      "handoff hook: deliverable processed",
    );
  });
  // #170 Slack-native: bridge the fleet into the customer's Slack. The service translates inbound Slack
  // events/interactions into the EXISTING audited paths (the same #123 trigger above, the #13 decision
  // path) and mirrors outputs back — no new authority. Two hooks register the outbound side: the
  // agent-reply mirror (`setChannelPostHook`) and the pending-approval DM (`setApprovalPendingHook`).
  // Both are no-ops unless a workspace has connected Slack. The digest tick is opt-in (started in
  // index.ts) and default-OFF.
  const slackService =
    opts.slack ?? createDefaultSlackService(app.log, { client: opts.slackClient });
  app.register(slackRoutes, { service: slackService });
  setChannelPostHook((post) => slackService.handleAgentPost(post));
  setApprovalPendingHook((request) => slackService.notifyApprovalPending(request));
  const slackDigestEngine = createDefaultSlackDigestEngine(app.log, slackService);
  app.decorate("slackDigestEngine", slackDigestEngine);
  // #56 Run tab: run a session's app for in-app preview + detect its localhost port, and route UI
  // annotations back to the agent (the #51 round trip). The RunProcessManager is SEPARATE from the
  // SessionManager (a dev server is long-lived; it must never finalize the session row). Killed on
  // server close so no preview process leaks past shutdown.
  const runManager = opts.runManager ?? createDefaultRunProcessManager(app.log);
  app.register(runRoutes, { runManager, sessionManager });
  app.addHook("onClose", async () => {
    setMarketingMentionTrigger(undefined);
    setChannelPostHook(undefined);
    setExternalRoomMirror(undefined);
    setIMessageRoomMirror(undefined);
    setDeliverableHandoffHook(undefined);
    setApprovalPendingHook(undefined);
    slackDigestEngine.stop();
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
  app.register(billingRoutes, {
    billingManager,
    planService,
    trialNurture,
    status: billingStatusValue,
  });
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
  // #190 support desk: bounded-autonomy answering layered on the #114 voice inbox — a venture KB (the
  // source of every answer's receipts), the routing gate (auto_send only when every fence passes AND an
  // AutoApprover is wired — the default has none, so every reply is still a #13 human gate), escalation
  // (anger/legal/refund→MONEY queue/unknown), SLA timers, and reality-grounded resolution metrics. Shares
  // the voice service so intake reuses #114 classification. Built before the console so it surfaces the SLA pane.
  const supportDeskService =
    opts.supportDesk ?? createDefaultSupportDeskService(undefined, voiceService);
  app.register(supportRoutes, { service: supportDeskService });
  // #196 legal & compliance pack: per-venture ToS/privacy generation (published via a pending #13 owner
  // approval), the name/trademark+domain pre-check the (#187) factory calls, the suppression/consent
  // rails enforced in code at the send chokepoint, and data export/deletion honored end-to-end. The
  // send-layer enforcement is wired into the executor registry; these routes manage the pack. Default OFF.
  const legalService = opts.legal ?? createDefaultLegalService();
  app.register(legalRoutes, { service: legalService });
  // #102 growth loop: distribution instrumentation. Record per-venture growth events (acquisition/
  // activation/conversion/retention), score the funnel, surface the score to the #96 scorecard + #107
  // portfolio loop + #104 console, and let the marketing fleet (#123) propose channel experiments —
  // external posting stays behind the existing #13 `external.send` gate (a human posts). Default-OFF.
  // Built before the console + portfolio loop so both can read per-venture growth.
  // #222 customer discovery engine: per-venture signal layer → ranked "who to reach out to now" queue +
  // PQL events + the 5-stage GTM pipeline. READ-ONLY (it never sends — outreach is #225). Shares the live
  // `growthService` so an ingested signal lights up the founder-console growth panel (#104) with real,
  // event-driven counts. Built before the console so the console can read the pipeline pane.
  // #223 decision-maker resolver — built here (before the console) so the #225 outreach engine can consume
  // its buyer briefs and the console can surface the outreach pane. Enrichment stays in a QUARANTINED
  // reader with no send/spend capability (#200).
  const decisionMakerService = opts.decisionMaker ?? createDefaultDecisionMakerService();
  // #225 outreach engine: consume the #222 discovery queue + #223 buyer brief to compose problem-led,
  // channel-specific messages, PARK each one for one-tap owner approval (never auto-sent — premortem #200),
  // and conclude message experiments from EXTERNAL receipts only. The injection-quarantine wall holds: the
  // brief is read as sanitized DATA and the recipient is always structural. Default-OFF (recorded-only).
  const outreachService =
    opts.outreach ??
    createDefaultOutreachService({
      discovery: discoveryService,
      decisionMaker: decisionMakerService,
      planService,
    });
  // #280 Reach outbound demand-gen: the self-improving loop service. Default-OFF + mock source + dry-run
  // sender, so it spends nothing and sends nothing until an owner opts in (caps) and connects a real ESP.
  const reachService = createDefaultReachService(app.log);
  // #294 SEO rank tracking: externally-grounded rank receipts feeding the SEO proof tile. Default-OFF +
  // dry-run provider, so it fetches nothing and records nothing until an owner connects a real rank source.
  const seoRankService = createDefaultSeoRankService(app.log);
  // #265 Search Console auto-submit: Scout submits the sitemap + requests indexing after the Google connect.
  // Default-OFF (owner-first) + dry-run provider + structural #13 always-gate — three independent layers, so
  // nothing is submitted live until an owner enables the flag, approves the submit, and a real provider is
  // wired behind the vault.
  const searchConsoleService = createDefaultSearchConsoleService(app.log);
  // #267 central provisioning: the SHARED seam the per-department adapters resolve paid-API credentials
  // through. Default-OFF + owner-workspace-first: with no `provisioning.enabled` set every capability
  // resolves to the free mock path and no central vault is read.
  const provisioningService = createDefaultProvisioningService();
  const adsService = createDefaultAdsService();
  // #340 enterprise layer: per-agent + per-customer usage metering, hard budget caps (also backing bid's money
  // caps), and the Passport IdP/SSO gate. Default-OFF + owner-workspace-first: with no `enterprise.enabled` set
  // it meters nothing live, enforces no cap, and the Passport gate is open (existing auth unchanged).
  const enterpriseService = createDefaultEnterpriseService();
  // Register the Passport IdP/SSO gate as an onRequest hook BEFORE the routes it protects. It is a no-op
  // unless `enterprise.passportEnabled` is on for the caller's workspace (default-OFF, owner-first), so it
  // never weakens existing auth; when enabled it refuses any internal request lacking a verified, allow-listed
  // IdP assertion. The default resolver returns no assertion (fail-closed) until a real IdP resolver is wired.
  app.addHook("onRequest", createEnterprisePassportHook({ loadCaps: enterpriseCapsFor }));
  const semanticService = opts.semantic ?? createDefaultSemanticLayerService();
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
    });
  const founderConsole =
    opts.founderConsole ??
    createDefaultFounderConsoleService({
      scale,
      billing: billingManager,
      moat: moatService,
      portfolio: portfolioService,
      voice: voiceService,
      supportDesk: supportDeskService,
      discovery: discoveryService,
      outreach: outreachService,
    });
  app.register(founderConsoleRoutes, { service: founderConsole });
  app.register(customerDeliverableRoutes);
  app.register(deliverableFeedbackRoutes);
  app.register(deliverablePerformanceRoutes);
  // #194 finance ledger: books that close themselves. The accounting layer posts external receipts
  // (Stripe events + the #71 usage estimate) into a per-venture ledger, closes the monthly books, and
  // forecasts runway. Read routes are caps-gated (409 when off); the opt-in tick (FINANCE_INTERVAL_MS,
  // default off, started in index.ts) posts + closes. NO outbound money provider is wired — money
  // movements stay human-gated + recorded-only in the #13 queue. Config default-OFF (`finance.enabled`).
  const finance = opts.finance ?? createDefaultFinanceService();
  app.register(financeRoutes, { service: finance });
  // #386 attributed-revenue ledger read surface: the projection joining fleet exposures to Stripe receipts
  // by happened-before causality. Default OFF, owner-workspace-first (409 until the workspace opts in).
  app.register(attributionRoutes);
  // #389 customer-facing identity read surface: the sanitized "face that sells" (name + avatar + voice) the
  // fleet presents on customer-facing comms. Identity/display ONLY — authorizes no send. Default OFF,
  // owner-workspace-first (409 until the workspace opts in).
  app.register(customerIdentityRoutes);
  const financeEngine = opts.financeEngine ?? createDefaultFinanceEngine(app.log, finance);
  app.addHook("onClose", async () => {
    financeEngine.stop();
  });
  app.decorate("financeEngine", financeEngine);
  // #188 venture monetization: every venture can charge money, the owner holds the keys. Drafting plans
  // is free; activating/re-pricing/payout changes queue as #13 MONEY decisions (exact amounts shown); the
  // opt-in tick (MONETIZATION_INTERVAL_MS, default off, started in index.ts) mints the REAL inbound-only
  // payment link AFTER the owner approves, using the venture's OWN Stripe key from the #192 vault — never
  // ipop's. Per-venture webhook revenue feeds the #194 ledger → #173 P&L. Config default-OFF.
  const monetization = opts.monetization ?? createDefaultMonetizationService(app.log);
  const monetizationEngine =
    opts.monetizationEngine ?? createDefaultMonetizationEngine(app.log, monetization);
  app.addHook("onClose", async () => {
    monetizationEngine.stop();
  });
  app.decorate("monetizationEngine", monetizationEngine);
  // #173 founder briefings: the company reports UP — a daily brief + weekly P&L report pushed to the
  // owner via the #148 email seam (+ optional #170 Slack DM), and ONE ordered decision queue (#13 +
  // #172 + #146). The read routes render the views into the console; the opt-in tick (BRIEFINGS_INTERVAL_MS,
  // default off, started in index.ts) delivers the digests. Read-only over the business domain — the only
  // write is the briefing's own delivery audit. Config default-OFF (`briefings.enabled`). Stopped on close.
  const founderBriefings =
    opts.founderBriefings ??
    createDefaultFounderBriefingsService({
      logger: app.log,
      scale,
      billing: billingManager,
      portfolio: portfolioService,
      // #170: when a workspace has connected Slack, the brief is DM'd to the owner over the same
      // owner-DM authority the Slack digest uses (a no-op for un-connected workspaces).
      slack: slackService,
      // #194: attach the finance close-pack section to the weekly report (caps-gated; off ⇒ unchanged).
      finance,
    });
  app.register(founderBriefingsRoutes, { service: founderBriefings });
  const founderBriefingsEngine =
    opts.founderBriefingsEngine ?? createDefaultFounderBriefingsEngine(app.log, founderBriefings);
  app.addHook("onClose", async () => {
    founderBriefingsEngine.stop();
  });
  app.decorate("founderBriefingsEngine", founderBriefingsEngine);
  // #416 content-cadence: the timed tick that briefs the fleet to write+publish the next target query so it
  // ships a steady stream of on-site content instead of re-auditing the homepage. The timer is started in
  // index.ts only when CONTENT_CADENCE_INTERVAL_MS > 0 (default OFF); per-workspace flags are default-OFF +
  // owner-first, so prod with the block unset is byte-for-byte unchanged.
  const contentCadenceEngine =
    opts.contentCadenceEngine ?? createDefaultContentCadenceEngine(app.log, sessionManager);
  app.addHook("onClose", async () => {
    contentCadenceEngine.stop();
  });
  app.decorate("contentCadenceEngine", contentCadenceEngine);
  // #192 external account onboarding: the human-once setup handoff. The fleet files a SETUP request when a
  // venture needs an external service (ESP/ad/analytics/registrar/hosting) — it parks as a #13 approval in
  // the decision queue. The owner pastes keys ONCE (sealed write-only into the #192 vault); agents then use
  // them via the resolver (never read back). Domains: owner buys, agent configures + verifies DNS with
  // receipts. Read routes always render the checklist; the risky writes 409 unless `onboarding.enabled`.
  const onboarding = opts.onboarding ?? createDefaultOnboardingService(app.log);
  // #264 DNS automation: the manager the three DNS-blocked lanes call (Search Console verification, email
  // auth, hosted-pages CNAME). Resolves the workspace's connected DNS provider (Cloudflare w/ a vault
  // token, else the dry-run default) and publishes + verifies records with receipts — no manual DNS edits.
  const dnsManager = opts.dnsManager ?? createDefaultDnsManager();
  app.register(onboardingRoutes, { service: onboarding, dnsManager });
  const realworld = opts.realworld ?? createDefaultRealworldActuatorService();
  app.register(realworldRoutes, { service: realworld });
  app.register(workspaceCapabilityRoutes);
  // #266 ipop hosted publishing: customer blogs + landing pages, zero repo, zero deploy. `/me/hosted/*`
  // drafts + parks a #13 approval (nothing goes live without the owner approving); the public serve route
  // returns only `published` pages. Default-OFF, owner-workspace-first.
  app.register(hostedRoutes);
  // #269 Echo social posting: the connect-once aggregator bridge. `/me/social/*` drafts a post + parks a
  // #13 approval (a post is irreversible — nothing fans out to a network without the owner approving).
  // The aggregator is dry-run by default, so nothing posts for real until an owner connects a live one.
  app.register(socialRoutes);
  // #258 connect-once integrations: the OAuth-first "connect once, the agents do the rest" surface.
  // Customer connectors are consumer OAuth; the internal GitHub site-publish connector (owner-only) seals
  // its token into the #192 vault so `publish_site` needs no Fly server secret.
  app.register(connectionsRoutes);
  app.register(imessageRoutes, {
    service: imessageService,
    webhookSecret: opts.imessageWebhookSecret ?? env.imessage.webhookSecret,
  });
  app.register(messagingReadinessRoutes, {
    telegram: telegramService,
    whatsapp: whatsappService,
    imessage: imessageService,
  });
  app.register(telegramRoutes, {
    service: telegramService,
    inboundTeamLaunch,
  });
  app.register(whatsappRoutes, {
    service: whatsappService,
    inboundTeamLaunch,
  });
  // #284 Agent Garden: browse the department fleet (the #282 registry contracts) + enable/disable each
  // agent per workspace. Default OFF, owner-workspace-first; enabling an external-send agent parks a #13
  // approval. The catalog is read-only and always listable.
  app.register(gardenRoutes);
  // #1065 SkillOpt review console: list staged self-improvement proposals + held-out validation receipts.
  // Adoption/rejection stays on the linked #13 approval request; this route is read-only.
  app.register(skilloptRoutes);
  // #464 agent execution tools: the runtime seam where an "acts outside" agent requests a real-world action
  // (publish/post/spend). Every invocation parks a PENDING #13 approval and NEVER fires on its own — the
  // action runs only after the owner approves it. The catalog is read-only and always listable.
  app.register(agentToolRoutes);
  // #371 named-department roster: the reload.chat "team" — named personas (roles + handles + colors), their
  // #282 registry presence, and the members-rail footer. Default OFF, owner-workspace-first; the roster is
  // read-only/always listable and seeding mints identity personas only (no new action path — #200).
  app.register(departmentRoutes);
  // #271 brand kit + asset store: the owner sets their brand identity once (logo/colours/voice); Mark
  // enforces it and the fleet draws from it to generate on-brand images into the per-workspace asset
  // store. Setting a kit is what connects the founder-console brand proof tile. Image generation is a
  // fleet operating cost (autonomous, no #13 gate); it stays default-OFF behind the real-world flag.
  app.register(brandKitRoutes);
  app.register(brandVoiceRoutes);
  // #189 acquisition execution: the email suppression list (read + manual add) + the signature-verified
  // ESP bounce/complaint webhook that keeps deliverability enforced in code. Default-OFF (the writes 409
  // until the workspace opts into acquisition email; the webhook secret lives in the #192 vault).
  app.register(acquisitionRoutes, { outreach: outreachService, reach: reachService });
  app.register(growthRoutes, { service: growthService });
  // #223 decision-maker resolver: target account (#222) -> the right buyer + a buyer brief (who, a
  // falsifiable why, what they care about, cited angle hooks). Enrichment runs in a QUARANTINED reader
  // with no send/spend capability; a poisoned profile can never steer an action (#200). Default-OFF (the
  // flag gates only the live web-reading posture; producing a brief from already-fetched public text is
  // harmless and always available, mirroring #102's always-on event ingest). Built above the console.
  app.register(decisionMakerRoutes, { service: decisionMakerService });
  // #222 customer discovery engine: define owner signals, ingest real product/channel receipts, and read
  // the ranked prospect queue / PQL events / GTM pipeline. Always-live ingest + reads (READ-ONLY surface).
  app.register(discoveryRoutes, { service: discoveryService });
  // GAP 1 leads centre: the autonomous loop's INBOUND mouth (ADR-0400). The public landing form posts to a
  // PUBLIC (unauth) `POST /inbound/leads` which persists an unverified lead, sends a signed confirmation,
  // then best-effort qualifies it into #222 and hands it to Reach only after the address verifies. Capture is
  // the safe default, ON whenever an owner workspace is resolved (marketing.ownerWorkspaceId); 503 until then.
  app.register(inboundLeadsRoutes, {
    discovery: discoveryService,
    ownerWorkspaceId: opts.inboundLeadsOwnerWorkspaceId ?? resolveInboundLeadsOwnerWorkspaceId(),
    warmLeadFollowup: createDefaultInboundLeadFollowup(reachService),
    confirmation: createDefaultInboundLeadConfirmationSender(),
  });
  // #225 outreach engine: preview drafts, PARK a message for one-tap owner approval (never auto-sent),
  // record EXTERNAL receipts (which advance the #222 pipeline), and read message experiments. No send
  // endpoint exists — the send happens only after the owner approves, via the recorded-only executor.
  app.register(outreachRoutes, { service: outreachService });
  // #1548 buying-intent scanner: scheduled Reddit/X monitors persist scored threads with quoted evidence
  // and draft an Echo reply into the owner approval queue. The connector provider is a seam (#395 owns the
  // live pipes); this route never posts externally and never changes send/spend approval gates.
  const intentScannerService = opts.intentScanner ?? createDefaultIntentScannerService();
  app.register(intentScannerRoutes, { service: intentScannerService });
  app.decorate("intentScannerService", intentScannerService);
  // #280 Reach outbound demand-gen: run a batch of the self-improving loop (source live-signal prospects →
  // score/dedupe → personalise → auto-send under caps + suppression → enrol cadence → measure → self-tune),
  // record external engagement receipts, and read the proof summary. Default-OFF (caps gate the batch); a
  // paid data source money-gates its search. No #13 gate on the send (autonomous under the caps).
  app.register(reachRoutes, { service: reachService });
  // #270 analytics auto-install + read: install the analytics tag on the workspace's site with no owner
  // code work, and read the externally-grounded metrics so Lens can report. Default-OFF, owner-first; the
  // read provider (`dryrun` default) decides whether real numbers flow. No #13 gate (not money).
  app.register(analyticsRoutes);
  app.register(workspaceContextRoutes);
  // #502: the "What are we marketing?" target — any workspace points the fleet at its product/app and the
  // agents read it as their brief. Not flag-gated (unlike #320's owner-first capture); this is the surface
  // that makes ipop market any company.
  app.register(marketingTargetRoutes);
  // #267 central provisioning read surface: what's provisioned for this workspace (never a key) + the
  // metered usage ledger. No connect/paste endpoint — the customer never provisions a key.
  app.register(provisioningRoutes, { service: provisioningService });
  app.register(adsRoutes, { service: adsService });
  // #340 enterprise layer read surface: metered usage per agent + per customer, and the budget caps. The
  // Passport gate (a default-OFF onRequest hook) is registered above — a no-op unless an owner enables it.
  app.register(enterpriseRoutes, { service: enterpriseService });
  app.register(seoRoutes, { service: seoRankService });
  app.register(searchConsoleRoutes, { service: searchConsoleService });
  app.register(semanticRoutes, { service: semanticService });
  app.register(portfolioRoutes, { service: portfolioService });
  // #115 product planning loop: feedback + metrics → RICE-ranked backlog → specs → proposed build
  // sessions. Record backlog items (RICE inputs derived from evidence counts), read the ranked backlog,
  // and run the planning tick — the top item is drafted into a spec and proposed through the
  // venture-gated #96 launcher; pivots / over-budget / not-#95-allowed dispatches #13-gate. Default-OFF.
  const planningService = opts.planning ?? createDefaultPlanningService(sessionManager);
  app.register(planningRoutes, { service: planningService });
  app.decorate("planningEngine", planningService);
  // #197 venture memory & planning loop: per-venture durable memory (reusing the #15 graph) retrieved
  // into every new session's brief, plus a weekly tick that drafts next week's backlog per venture from
  // scorecard + memory + OKR drift, cites the #200 premortem in its go/no-go (verified metrics only,
  // estimates UNVERIFIED), lands the plan as a #13 owner gate, and on approval flows items into the #115
  // backlog (which auto-dispatches). Recording/reading is always available; the weekly tick is default-OFF.
  const ventureMemoryService = opts.ventureMemory ?? createDefaultVentureMemoryService();
  app.register(ventureMemoryRoutes, { service: ventureMemoryService });
  app.decorate("ventureMemoryEngine", ventureMemoryService);
  // #117 self-healing flywheel: create the recorder before downstream loops capture it so infrastructure
  // failures can fingerprint into the same durable failure stream.
  const flywheelEngine = opts.flywheel ?? createDefaultFlywheelEngine(app.log, sessionManager);
  const recordFailureToFlywheel = (event: Parameters<typeof flywheelEngine.record>[0]) =>
    flywheelEngine.record(event);
  app.addHook("onClose", async () => {
    flywheelEngine.stop();
  });
  app.decorate("flywheelEngine", flywheelEngine);
  // #172 self-shipping loop: agent-ok issues → cloud build sessions → auto-review against the house
  // rubric → auto-merge ONLY within guardrails (reviewer PASS, CI green, no protected-path touched,
  // diff under cap, agent-ok) → rebase-train → post-merge verify (proposing, never executing, a revert).
  // Record issues + read runs are always available; every auto action is gated by the config flag +
  // the #17 kill switch, and out-of-guardrail steps escalate via the #13 queue. Default-OFF; the repo
  // host defaults to a no-op (no GitHub) so CI never ships. The timer is started in index.ts.
  // #195 venture deploys: a merged VENTURE run goes through the deploy → smoke → promote/rollback release
  // pipeline as the build loop's post-merge verifier. For agent-skills' OWN self-shipping the verifier
  // resolves no venture, so it is a byte-for-byte no-op — wiring venture repos through the loop (the
  // `resolveVenture` registry) is a follow-up seam.
  const ventureReleaseVerifier = releasePipelineAsPostMergeVerifier(
    createDefaultVentureReleasePipeline({
      flywheelRecord: (event) => app.flywheelEngine.record(event),
    }),
    () => null,
  );
  const buildLoopEngine =
    opts.buildLoop ?? createDefaultBuildLoopEngine(app.log, sessionManager, ventureReleaseVerifier);
  app.register(buildLoopRoutes, { engine: buildLoopEngine });
  app.addHook("onClose", async () => {
    buildLoopEngine.stop();
  });
  app.decorate("buildLoopEngine", buildLoopEngine);
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
  app.register(teamRoutes, {
    coordinator: teamCoordinator,
    runtimeProvider,
    runtimeStatus,
    defaultHarness: env.agent.harness,
    claudeRuntimeStatus,
    codexSubscription,
    staleSessionReaper: createTeamRunStaleSessionReaper({ sessionManager }),
  });
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
    flywheelRecord: recordFailureToFlywheel,
    logger: app.log,
  });
  // #114 customer-voice overlay is also threaded into the venture service so real post-launch voice can
  // replace the synthetic problemSeverity dimension (default-OFF until the voice loop is configured).
  const ventureService =
    opts.venture ??
    createDefaultVentureService(undefined, demandService, constitutionGuard, voiceService);
  app.register(ventureRoutes, {
    service: ventureService,
    monetization,
    resolveVentureWorkspaceId: async (ventureIdeaId) =>
      (await getIdeaById(ventureIdeaId))?.workspaceId,
  });
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
    createDefaultAutonomyEngine(
      app.log,
      sessionManager,
      gatedAutonomyLauncher,
      recordFailureToFlywheel,
    );
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
  const watchdogEngine =
    opts.watchdog ?? createDefaultWatchdogEngine(app.log, sessionManager, recordFailureToFlywheel);
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
  const sreEngine =
    opts.sre ?? createDefaultSreEngine(app.log, sessionManager, recordFailureToFlywheel);
  app.addHook("onClose", async () => {
    sreEngine.stop();
  });
  app.decorate("sreEngine", sreEngine);
  app.register(sreRoutes);
  // #148 reliability surface: the incident.io-class operating layer on top of the #112 loop. The
  // owner-paging / war-room / AI-investigation behavior attaches at the SRE `notifier` seam (see
  // `createDefaultSreEngine`), so there is no new engine here — only the public status page
  // (UNAUTHENTICATED, opt-in per workspace via `reliability.statusPageEnabled`) and the authenticated
  // ack / overlay / page-audit reads. All default-OFF.
  app.register(statusRoutes);
  app.register(reliabilityRoutes);
  // #106 outcome verifiers: read-only surface for a workspace's durable verification verdicts.
  app.register(verifierRoutes);
  // #191 deliverable verification layer: read-only proof surface (verdicts + the definition of done).
  app.register(verificationRoutes);
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
  // #171 self-QA loop: a synthetic user E2E-tests the LIVE product on a schedule and files its own
  // deduped bug issues. Findings flow through the #117 flywheel above (recorded as `qa_failure`) and,
  // on the CI path, into GitHub via the #57 provider; criticals page the owner through the #148 seam.
  // Tenant-locked to the reserved synthetic workspace, budget-capped, config default-OFF + opt-in timer
  // (SELFQA_INTERVAL_MS, started in index.ts) — the always-on entry is the `selfqa:run` CLI. Stopped on close.
  const selfqaEngine = opts.selfqa ?? createDefaultSelfQaEngine(app.log, recordFailureToFlywheel);
  app.addHook("onClose", async () => {
    selfqaEngine.stop();
  });
  app.decorate("selfqaEngine", selfqaEngine);
  // #193 self-healing ops: ventures stay alive at 3am without the owner. A default-OFF, kill-switch-
  // and maintenance-gated tick probes every live venture surface (a REAL HTTP probe — #200 §3),
  // evaluates per-venture uptime/error/queue thresholds, and picks a reversibility-classed action:
  // restart auto-runs (reversible) through the SAME #92 launcher; rollback/scale are destructive and
  // go to the #13 queue unless the owner pre-committed them; an action retried once that still fails
  // escalates AND self-files a postmortem (`agent-ok` issue → #172 loop + an `ops_incident` flywheel
  // row). `autoRemediate` is an independent second switch (off ⇒ escalate-only). The timer is opt-in
  // (SELF_HEALING_INTERVAL_MS, started in index.ts); tests inject the engine and drive `tickWorkspace()`.
  // Stopped on close. Read-only routes surface the open incidents (the console fleet-health signal).
  const selfHealingEngine =
    opts.selfHealing ??
    createDefaultSelfHealingEngine(app.log, sessionManager, (event) =>
      app.flywheelEngine.record(event),
    );
  app.addHook("onClose", async () => {
    selfHealingEngine.stop();
  });
  app.decorate("selfHealingEngine", selfHealingEngine);
  app.register(selfHealingRoutes);
  // #147 automations: owner-defined scheduled/webhook agent tasks. A default-OFF, kill-switch-gated
  // tick launches each due automation through the SAME #123 venture-gated launcher a human @mention
  // uses (so #96/#71 gating + #13-gated sends are inherited), recording a durable run. Run-now + the
  // public webhook route share `runAutomation`. The timer is opt-in (AUTOMATIONS_INTERVAL_MS, started
  // in index.ts). Mission control + the audit trail are read-only viewers over existing rows.
  const automationEngine =
    opts.automations ?? createDefaultAutomationEngine(app.log, sessionManager);
  app.register(automationRoutes, { engine: automationEngine, store: automationStore });
  app.addHook("onClose", async () => {
    automationEngine.stop();
  });
  app.decorate("automationEngine", automationEngine);
  // #152 workspace catalog + visual workflow builder: the generalization of #147 automations into
  // trigger → condition → action chains, plus a structured registry of marketing assets agents read for
  // context. The engine reuses the SAME #123 venture-gated launcher (agent_task), the #13 gate
  // (draft_send → a PENDING approval, never an egress), and the #8 notifier (notify_owner); a FAILED
  // firing feeds the #117 flywheel. Both surfaces are config default-OFF (`catalog.enabled` /
  // `workflows.enabled`); the tick is opt-in (WORKFLOWS_INTERVAL_MS, registered on the #559 scheduler in
  // index.ts). A catalog mutation fires the workflow's `catalog_change` triggers (best-effort, never awaited).
  const workflowEngine =
    opts.workflows ??
    createDefaultWorkflowEngine(app.log, sessionManager, (event) => flywheelEngine.record(event));
  app.register(catalogRoutes, { workflowEngine });
  app.register(workflowRoutes, { engine: workflowEngine, store: workflowStore });
  app.decorate("workflowEngine", workflowEngine);
  // #590 dependency-aware scheduler: declare content/review/publish task graphs and only claim runnable work.
  // The service is default-OFF for execution (DEP_SCHEDULER_ENABLED) but planning/listing remain visible.
  const dependencyScheduler = opts.dependencyScheduler ?? createDefaultDependencySchedulerService();
  app.register(dependencySchedulerRoutes, { service: dependencyScheduler });
  // #559 durable, single-leader scheduler: the restart-safe replacement for the per-engine `setInterval`
  // tick loops (planning / venture-memory / verifiers / workflows). `index.ts` registers each engine's
  // `tickAll` as a durable job (persisted cursor + leader lease in `scheduler_jobs`) and calls `start()`;
  // here we only construct + decorate + stop-on-close. Default-inert until an engine's *_INTERVAL_MS opts in.
  const scheduler = opts.scheduler ?? createDefaultScheduler(app.log);
  app.addHook("onClose", async () => {
    scheduler.stop();
  });
  app.decorate("scheduler", scheduler);
  const missionControl = opts.missionControl ?? createDefaultMissionControlService();
  app.register(missionControlRoutes, { service: missionControl, sessionManager });
  const auditService = opts.audit ?? createDefaultAuditService();
  app.register(auditRoutes, { service: auditService });
  // #155 eval-gated maintenance: run an agent's offline eval suite → persist `eval_runs` → trace →
  // (when enabled) feed a regression to the flywheel above as an `eval_regression` failure. Default OFF
  // gates only the proactive feed; running + recording an eval is always available + tenant-scoped.
  const evalService = opts.evals ?? createDefaultEvalService({ flywheel: flywheelEngine });
  app.register(evalRoutes, { service: evalService });
  // #106 outcome verifiers: the measured-gate runner. It turns non-code claims (deploy live? revenue
  // real? growth moved? fix held?) into durable `verifier_results` evidence rows via pure verifier
  // modules, and a FAILED verification opens a #13 escalation (never silently passes). It is config
  // default-OFF (`verifiers.enabled`) + the tick is opt-in (VERIFIERS_INTERVAL_MS, registered on the #559
  // scheduler in index.ts), so wiring it changes nothing until a deployment opts in.
  const verifierRunner = opts.verifiers ?? createDefaultVerifierRunner(app.log);
  app.decorate("verifierRunner", verifierRunner);
  // #191 deliverable verification routes read the engine decorated above; #853 also routes delivery through
  // that same engine, so shipped deliverables have verdict evidence instead of bypassing the layer.
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
  // #187 venture factory: the opportunity scanner → edge gate → validation → idempotent bootstrap →
  // kill/scale pipeline. Config default-OFF (`ventureFactory.enabled`) + the scanner timer is opt-in
  // (VENTURE_FACTORY_INTERVAL_MS, started in index.ts), so wiring it changes nothing until a deployment
  // opts in. The real #138 fleet seed / #98 profitability / #107 archiver injections are a follow-up.
  // #195 inject the deploy-target provisioner so the factory's reversible `repo_deploy_target` bootstrap
  // step provisions a per-venture Fly/Vercel target (idempotent, budget-capped). Default-OFF via config.
  const ventureFactoryDeps = {
    deploy: createDefaultVentureDeployProvisioner(),
  };
  const ventureFactoryService = createDefaultVentureFactoryService(ventureFactoryDeps);
  app.register(ventureFactoryRoutes, { service: ventureFactoryService });
  const ventureFactoryEngine = createDefaultVentureFactoryEngine(app.log, ventureFactoryDeps);
  app.addHook("onClose", async () => {
    ventureFactoryEngine.stop();
  });
  app.decorate("ventureFactoryEngine", ventureFactoryEngine);
  // #416 autonomous work cadence: the recurring tick that keeps the fleet working ON ipop.ai's own growth
  // (the draft-only dogfood playbook) so the work doesn't stop after a single one-shot brief. Config
  // default-OFF + owner-workspace-first + a hard per-day launch cap, and the timer is opt-in
  // (RELOAD_CADENCE_INTERVAL_MS, started in index.ts only when > 0). Reuses the existing owner-brief launch
  // path (no new authority; draft-only goals; outbound still #13-gated), so wiring it changes nothing until
  // a deployment opts in.
  const cadenceEngine = createDefaultCadenceEngine(sessionManager, app.log);
  app.addHook("onClose", async () => {
    cadenceEngine.stop();
  });
  app.decorate("cadenceEngine", cadenceEngine);
  // #283 SkillOpt-Sleep: the nightly self-improvement tick (RELOAD_SKILLOPT_INTERVAL_MS, started in index.ts
  // only when > 0). Config default-OFF + owner-workspace-first; it stages at most a #13 proposal and edits
  // no doc, so wiring it changes nothing until a deployment opts in. Stopped on server close.
  const skilloptEngine = createDefaultSkillOptEngine(app.log);
  app.addHook("onClose", async () => {
    skilloptEngine.stop();
  });
  app.decorate("skilloptEngine", skilloptEngine);
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
