import { CONFIG_DEFAULTS, type ResolvedConfig, type Settings } from "./schema.js";

/**
 * Pure layer merge (#58). Layers are supplied **low → high precedence**; for each field the
 * last layer that defines it wins. Arrays are **replaced**, not concatenated (a higher layer fully
 * owns the value). This is the mechanism that makes the managed layer (applied last) the lock.
 */
export function mergeSettings(layers: Settings[]): Settings {
  const out: Settings = {};
  for (const layer of layers) {
    if (layer.dataPrivacyMode !== undefined) out.dataPrivacyMode = layer.dataPrivacyMode;
    if (layer.filesToCopy !== undefined) out.filesToCopy = [...layer.filesToCopy];
    if (layer.workspaceRoot !== undefined) out.workspaceRoot = layer.workspaceRoot;
    // #57 record fields: a higher layer fully owns the value (replace, consistent with arrays). A
    // partial map in a higher layer therefore wins outright — it is not deep-merged with lower ones.
    if (layer.slashCommands !== undefined) out.slashCommands = { ...layer.slashCommands };
    if (layer.mcpServers !== undefined) out.mcpServers = { ...layer.mcpServers };
    if (layer.skills !== undefined) out.skills = [...layer.skills];
    // #56 run command: a higher layer fully owns the value (replace, consistent with the records above).
    if (layer.run !== undefined) out.run = { ...layer.run };
    // #73 deploy settings: a higher layer fully owns the block (replace, consistent with run/models).
    if (layer.deploy !== undefined) out.deploy = { ...layer.deploy };
    // #52 model policy: a higher layer fully owns the block (replace, consistent with records above)
    // so a managed-layer tenant's allow-list cannot be widened by a lower layer.
    if (layer.models !== undefined) out.models = { ...layer.models };
    // auto model-selection policy (convene-llm-gateway): a higher layer fully owns the block (replace)
    // so a managed-layer tenant's auto on/off + cost ceiling cannot be flipped by a lower layer.
    if (layer.autoModel !== undefined) out.autoModel = { ...layer.autoModel };
    // #71 scale policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // caps/budget cannot be loosened by a lower layer.
    if (layer.scale !== undefined) out.scale = { ...layer.scale };
    // #98 billing settings: a higher layer fully owns the block (replace, consistent with deploy/run).
    if (layer.billing !== undefined) out.billing = { ...layer.billing };
    // #96 venture policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // gate flag/thresholds cannot be loosened (e.g. the gate turned off) by a lower layer.
    if (layer.venture !== undefined) out.venture = { ...layer.venture };
    // #105 watchdog policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // supervisor flag / bounds cannot be loosened (e.g. the watchdog turned off) by a lower layer.
    if (layer.watchdog !== undefined) out.watchdog = { ...layer.watchdog };
    // #112 SRE policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // on-call flag / SLO targets cannot be loosened (e.g. the loop turned off) by a lower layer.
    if (layer.sre !== undefined) out.sre = { ...layer.sre };
    // #193 self-healing policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's monitoring / auto-remediation / destructive-action gates cannot be loosened below.
    if (layer.selfHealing !== undefined) out.selfHealing = { ...layer.selfHealing };
    // #148 reliability policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // paging/status-page flags cannot be loosened (e.g. paging turned off) by a lower layer.
    if (layer.reliability !== undefined) out.reliability = { ...layer.reliability };
    // #119 gate-pricing policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's pricer flag / rails cannot be loosened (e.g. auto-relax turned off) by a lower layer.
    if (layer.gatePricing !== undefined) out.gatePricing = { ...layer.gatePricing };
    // #117 flywheel policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // self-healing flag / bounds (rate limit, concurrency cap) cannot be loosened by a lower layer.
    if (layer.flywheel !== undefined) out.flywheel = { ...layer.flywheel };
    // #171 self-QA policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // synthetic-QA flag / workspace slug cannot be redirected at a real tenant by a lower layer.
    if (layer.selfqa !== undefined) out.selfqa = { ...layer.selfqa };
    // #123 marketing policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // seed-on-signup flag cannot be flipped on/off by a lower layer.
    if (layer.marketing !== undefined) out.marketing = { ...layer.marketing };
    // #106 verifiers policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // verifier flag / "no silent pass" escalation rail cannot be loosened by a lower layer.
    if (layer.verifiers !== undefined) out.verifiers = { ...layer.verifiers };
    // #191 verification policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // verification flag / auto-send + production-grounding rails cannot be loosened by a lower layer.
    if (layer.verification !== undefined) out.verification = { ...layer.verification };
    // #102 growth policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // growth flag / traffic floor cannot be loosened by a lower layer.
    if (layer.growth !== undefined) out.growth = { ...layer.growth };
    // #223 decision-maker policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // live-web-reading flag / hook cap cannot be loosened (e.g. live reading turned on) by a lower layer.
    if (layer.decisionMaker !== undefined) out.decisionMaker = { ...layer.decisionMaker };
    // #100 insight policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // mining flag / cost cap / source cut cannot be loosened (e.g. mining turned off) by a lower layer.
    if (layer.insight !== undefined) out.insight = { ...layer.insight };
    // #103 moat policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // stagnation flagging / weights cannot be loosened (e.g. flagging turned off) by a lower layer.
    if (layer.moat !== undefined) out.moat = { ...layer.moat };
    // #114 voice policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // voice flag / auto-draft posture cannot be loosened (e.g. auto-draft turned on) by a lower layer.
    if (layer.voice !== undefined) out.voice = { ...layer.voice };
    // #190 support-desk policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // autonomous-send posture (autoSend / categories / per-day cap) cannot be loosened by a lower layer.
    if (layer.supportDesk !== undefined) out.supportDesk = { ...layer.supportDesk };
    // #196 legal policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // pack flag / consent posture cannot be loosened (e.g. enforcement turned off) by a lower layer.
    if (layer.legal !== undefined) out.legal = { ...layer.legal };
    // #107 portfolio policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // review flag / thresholds cannot be loosened (e.g. the loop turned off) by a lower layer.
    if (layer.portfolio !== undefined) out.portfolio = { ...layer.portfolio };
    // #115 planning policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // planning flag / effort ceiling / dispatch caps cannot be loosened by a lower layer.
    if (layer.planning !== undefined) out.planning = { ...layer.planning };
    // #197 venture-memory/planning policy: a higher layer fully owns the block (replace) so a
    // managed-layer tenant's weekly-tick flag / plan caps cannot be loosened by a lower layer.
    if (layer.ventureMemory !== undefined) out.ventureMemory = { ...layer.ventureMemory };
    // #187 venture-factory policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's factory flag / budget caps / scaling gate cannot be loosened by a lower layer.
    if (layer.ventureFactory !== undefined) out.ventureFactory = { ...layer.ventureFactory };
    // #195 venture-deploys policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's deploy flag / provider / cutover-gate cannot be loosened by a lower layer.
    if (layer.ventureDeploys !== undefined) out.ventureDeploys = { ...layer.ventureDeploys };
    // #151 credential-scopes policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's per-agent allowlist matrix cannot be widened (e.g. scoping turned off) by a lower layer.
    if (layer.credentialScopes !== undefined) out.credentialScopes = { ...layer.credentialScopes };
    // #151 egress policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // domain allowlist cannot be widened (e.g. the allowlist turned off) by a lower layer.
    if (layer.egress !== undefined) out.egress = { ...layer.egress };
    // #151 rbac policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // role enforcement cannot be turned off by a lower layer.
    if (layer.rbac !== undefined) out.rbac = { ...layer.rbac };
    // #147 automations policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // automations flag / run caps cannot be loosened by a lower layer.
    if (layer.automations !== undefined) out.automations = { ...layer.automations };
    // #146 constitution policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's constitution flag / thresholds cannot be loosened (e.g. enforcement turned off) by a
    // lower layer.
    if (layer.constitution !== undefined) out.constitution = { ...layer.constitution };
    // #155 fleet policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // eval-maintenance flag / freshness ceiling / regression tolerance cannot be loosened by a lower layer.
    if (layer.fleet !== undefined) out.fleet = { ...layer.fleet };
    // #152 catalog policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // catalog flag / entry cap cannot be loosened by a lower layer.
    if (layer.catalog !== undefined) out.catalog = { ...layer.catalog };
    // #152 workflows policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // workflows flag / firing caps cannot be loosened by a lower layer.
    if (layer.workflows !== undefined) out.workflows = { ...layer.workflows };
    // #172 build-loop policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // self-shipping flag / guardrail bounds (concurrency, size cap, protected paths) cannot be loosened
    // by a lower layer.
    if (layer.buildLoop !== undefined) out.buildLoop = { ...layer.buildLoop };
    // #170 slack policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // Slack surface / digest flag cannot be flipped on/off by a lower layer.
    if (layer.slack !== undefined) out.slack = { ...layer.slack };
    // #173 briefings policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // briefing flag / cadence cannot be loosened (e.g. delivery turned off) by a lower layer.
    if (layer.briefings !== undefined) out.briefings = { ...layer.briefings };
    // #174 browser policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // browser flag / caps / domain lists cannot be loosened (e.g. the browser turned on, or the
    // denylist dropped) by a lower layer.
    if (layer.browser !== undefined) out.browser = { ...layer.browser };
    // #192 onboarding policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // onboarding flag / DNS provider cannot be flipped (e.g. credential injection turned on) by a lower layer.
    if (layer.onboarding !== undefined) out.onboarding = { ...layer.onboarding };
    // #231 real-world tool surface: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's real-world flag / publish provider cannot be flipped on (e.g. a live publisher) by a
    // lower layer.
    if (layer.realworld !== undefined) out.realworld = { ...layer.realworld };
    // #225 outreach policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // outreach flag / sender / per-channel cap cannot be loosened (e.g. a live sender turned on, or the
    // rate cap raised) by a lower layer.
    if (layer.outreach !== undefined) out.outreach = { ...layer.outreach };
    // #189 acquisition policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // real-send flags / auto-send switch / send caps cannot be loosened (e.g. real ads turned on, or a
    // window cap raised) by a lower layer.
    if (layer.acquisition !== undefined) out.acquisition = { ...layer.acquisition };
    // #295 delivery policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // approve→publish ship flags + owner-workspace scope cannot be loosened by a lower layer.
    if (layer.delivery !== undefined) out.delivery = { ...layer.delivery };
    // #337 action contract policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // contract master flag + owner-workspace scope + the irreversible-apply switch cannot be loosened by a
    // lower layer.
    if (layer.actionContract !== undefined) out.actionContract = { ...layer.actionContract };
    // #267 central provisioning policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // provisioning flag + owner-workspace scope + provider map cannot be flipped on by a lower layer.
    if (layer.provisioning !== undefined) out.provisioning = { ...layer.provisioning };
    // #272 ads spend policy: a higher (managed/owner) layer fully owns the block (replace) so the ad-spend
    // flag + owner-workspace scope + hard per-action cap cannot be flipped on / loosened by a lower layer.
    if (layer.ads !== undefined) out.ads = { ...layer.ads };
    // #340 enterprise layer: a higher (managed/owner) layer fully owns the block (replace) so the metering /
    // cap-enforcement / passport flags + owner-workspace scope cannot be loosened by a lower layer (e.g. a
    // tenant turning off its own budget cap or the Passport gate).
    if (layer.enterprise !== undefined) out.enterprise = { ...layer.enterprise };
    // #266 hosted publishing: a higher (managed/owner) layer fully owns the block (replace) so the
    // hosting master flag + owner-workspace scope cannot be loosened by a lower layer.
    if (layer.hostedSites !== undefined) out.hostedSites = { ...layer.hostedSites };
    // #269 social posting: a higher (managed/owner) layer fully owns the block (replace) so the social
    // master flag + owner-workspace scope cannot be loosened by a lower layer.
    if (layer.social !== undefined) out.social = { ...layer.social };
    // #194 finance policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // ledger/close tick + the read surface cannot be flipped on by a lower layer — owner-workspace-first.
    if (layer.finance !== undefined) out.finance = { ...layer.finance };
    // #386 attributed-revenue ledger: a higher (managed/owner) layer fully owns the block (replace) so
    // tracking-id stamping + the attribution projection cannot be flipped on by a lower layer.
    if (layer.attribution !== undefined) out.attribution = { ...layer.attribution };
    // #389 customer-facing identity: a higher (managed/owner) layer fully owns the block (replace) so the
    // presented founder name/avatar/voice cannot be flipped on by a lower layer — owner-workspace-first.
    if (layer.customerIdentity !== undefined) out.customerIdentity = { ...layer.customerIdentity };
    // #388 browser session-injection: a higher (managed/owner) layer fully owns the block (replace) so
    // injecting a per-workspace logged-in session cannot be flipped on by a lower layer — owner-first.
    if (layer.sessionInjection !== undefined) out.sessionInjection = { ...layer.sessionInjection };
    // #188 monetization policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // money-gated activation + per-venture revenue ingestion cannot be flipped on by a lower layer.
    if (layer.monetization !== undefined) out.monetization = { ...layer.monetization };
    // #222 discovery policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // proactive posture + queue limits cannot be loosened by a lower layer — owner-workspace-first.
    if (layer.discovery !== undefined) out.discovery = { ...layer.discovery };
    // #280 reach policy: a higher (managed/owner) layer fully owns the block (replace) so the autonomous
    // send posture + per-domain caps + paid-source selection cannot be loosened by a lower layer.
    if (layer.reach !== undefined) out.reach = { ...layer.reach };
    // #294 SEO rank-tracking policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // proactive-fetch flag + provider + target keywords cannot be loosened by a lower layer.
    if (layer.seo !== undefined) out.seo = { ...layer.seo };
    // #270 analytics auto-install + read policy: a higher (managed/owner) layer fully owns the block
    // (replace) so the auto-install flag + read provider + owner-workspace scope cannot be loosened by a
    // lower layer.
    if (layer.analytics !== undefined) out.analytics = { ...layer.analytics };
    // #282 agent registry + A2A policy: a higher (managed/owner) layer fully owns the block (replace) so
    // the A2A flag + owner-first restriction + depth cap cannot be loosened by a lower layer.
    if (layer.agentRegistry !== undefined) out.agentRegistry = { ...layer.agentRegistry };
    // #319 agent collaboration policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // spawn-provisioning flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.agentCollaboration !== undefined) out.agentCollaboration = { ...layer.agentCollaboration };
    // #370 agent→channel posting policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // posting flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.agentChannelPosting !== undefined) out.agentChannelPosting = { ...layer.agentChannelPosting };
    // #284 agent Garden policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // manage flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.garden !== undefined) out.garden = { ...layer.garden };
    // #343 worktree-pool policy: a higher (managed/owner) layer fully owns the block (replace) so the warm-pool
    // flag + owner-first restriction + size cap cannot be loosened by a lower layer.
    if (layer.worktreePool !== undefined) out.worktreePool = { ...layer.worktreePool };
    // #353 open-design policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // offer flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.openDesign !== undefined) out.openDesign = { ...layer.openDesign };
    // #262 connect-Claude policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // managed one-click flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.connectClaude !== undefined) out.connectClaude = { ...layer.connectClaude };
    // #258 Stage 2 connect-once policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // live-flow flag + owner-first restriction cannot be loosened by a lower layer.
    if (layer.connectOnce !== undefined) out.connectOnce = { ...layer.connectOnce };
    // #336 capability-token mint policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // live-mint flag + owner-first restriction + TTL bounds cannot be loosened by a lower layer.
    if (layer.capabilityTokens !== undefined) out.capabilityTokens = { ...layer.capabilityTokens };
    // #283 SkillOpt-Sleep policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // self-improvement flag + owner-first restriction + gate bounds cannot be loosened by a lower layer.
    if (layer.skillopt !== undefined) out.skillopt = { ...layer.skillopt };
    // #356 Oz-loops policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // triage/spec/review/pr-comment flag + owner-first restriction + ingest bounds cannot be loosened by a
    // lower layer.
    if (layer.ozLoops !== undefined) out.ozLoops = { ...layer.ozLoops };
    // #371 named-department policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // seed flag + owner-first restriction + roster overrides cannot be loosened/redirected by a lower layer.
    if (layer.department !== undefined) out.department = { ...layer.department };
    // #338 durable-workflow policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // durable-path flag + owner-first restriction + retry/deadline bounds cannot be loosened by a lower layer.
    if (layer.durableWorkflow !== undefined) out.durableWorkflow = { ...layer.durableWorkflow };
    // #300 signup-entry policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // sample-workspace + progressive-scopes flags cannot be loosened by a lower layer.
    if (layer.signupEntry !== undefined) out.signupEntry = { ...layer.signupEntry };
    // #268 email deliverability policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // live-send flag + owner-first restriction + rate cap cannot be loosened by a lower layer.
    if (layer.emailDeliverability !== undefined) out.emailDeliverability = { ...layer.emailDeliverability };
    // #403 autonomous-send policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // enable flag + owner-first restriction + the hard window/daily caps cannot be loosened by a lower layer.
    if (layer.autonomousSend !== undefined) out.autonomousSend = { ...layer.autonomousSend };
  }
  return out;
}

/** Merge partial layers (low → high) over the built-in defaults into a fully-resolved config. */
export function mergeLayers(layers: Settings[]): ResolvedConfig {
  const merged = mergeSettings(layers);
  return {
    dataPrivacyMode: merged.dataPrivacyMode ?? CONFIG_DEFAULTS.dataPrivacyMode,
    filesToCopy: merged.filesToCopy ?? [...CONFIG_DEFAULTS.filesToCopy],
    workspaceRoot: merged.workspaceRoot ?? CONFIG_DEFAULTS.workspaceRoot,
    slashCommands: merged.slashCommands ?? { ...CONFIG_DEFAULTS.slashCommands },
    mcpServers: merged.mcpServers ?? { ...CONFIG_DEFAULTS.mcpServers },
    skills: merged.skills ?? [...CONFIG_DEFAULTS.skills],
    // #56: no default run command — absent means the deployment configured none (Run tab → 409).
    run: merged.run,
    // #73: no default deploy settings — absent means deploy is not enabled (Deploy tab → 409).
    deploy: merged.deploy,
    models: merged.models ?? { ...CONFIG_DEFAULTS.models },
    autoModel: merged.autoModel ?? { ...CONFIG_DEFAULTS.autoModel },
    scale: merged.scale ?? { ...CONFIG_DEFAULTS.scale },
    // #98: no default billing settings — absent means billing is not enabled (inbound routes → 409).
    billing: merged.billing,
    venture: merged.venture ?? { ...CONFIG_DEFAULTS.venture },
    watchdog: merged.watchdog ?? { ...CONFIG_DEFAULTS.watchdog },
    sre: merged.sre ?? { ...CONFIG_DEFAULTS.sre },
    selfHealing: merged.selfHealing ?? { ...CONFIG_DEFAULTS.selfHealing },
    reliability: merged.reliability ?? { ...CONFIG_DEFAULTS.reliability },
    gatePricing: merged.gatePricing ?? { ...CONFIG_DEFAULTS.gatePricing },
    flywheel: merged.flywheel ?? { ...CONFIG_DEFAULTS.flywheel },
    selfqa: merged.selfqa ?? { ...CONFIG_DEFAULTS.selfqa },
    marketing: merged.marketing ?? { ...CONFIG_DEFAULTS.marketing },
    verifiers: merged.verifiers ?? { ...CONFIG_DEFAULTS.verifiers },
    verification: merged.verification ?? { ...CONFIG_DEFAULTS.verification },
    growth: merged.growth ?? { ...CONFIG_DEFAULTS.growth },
    decisionMaker: merged.decisionMaker ?? { ...CONFIG_DEFAULTS.decisionMaker },
    insight: merged.insight ?? { ...CONFIG_DEFAULTS.insight },
    moat: merged.moat ?? { ...CONFIG_DEFAULTS.moat },
    voice: merged.voice ?? { ...CONFIG_DEFAULTS.voice },
    supportDesk: merged.supportDesk ?? { ...CONFIG_DEFAULTS.supportDesk },
    legal: merged.legal ?? { ...CONFIG_DEFAULTS.legal },
    portfolio: merged.portfolio ?? { ...CONFIG_DEFAULTS.portfolio },
    planning: merged.planning ?? { ...CONFIG_DEFAULTS.planning },
    ventureMemory: merged.ventureMemory ?? { ...CONFIG_DEFAULTS.ventureMemory },
    ventureFactory: merged.ventureFactory ?? { ...CONFIG_DEFAULTS.ventureFactory },
    ventureDeploys: merged.ventureDeploys ?? { ...CONFIG_DEFAULTS.ventureDeploys },
    credentialScopes: merged.credentialScopes ?? { ...CONFIG_DEFAULTS.credentialScopes },
    egress: merged.egress ?? { ...CONFIG_DEFAULTS.egress },
    rbac: merged.rbac ?? { ...CONFIG_DEFAULTS.rbac },
    automations: merged.automations ?? { ...CONFIG_DEFAULTS.automations },
    constitution: merged.constitution ?? { ...CONFIG_DEFAULTS.constitution },
    fleet: merged.fleet ?? { ...CONFIG_DEFAULTS.fleet },
    catalog: merged.catalog ?? { ...CONFIG_DEFAULTS.catalog },
    workflows: merged.workflows ?? { ...CONFIG_DEFAULTS.workflows },
    buildLoop: merged.buildLoop ?? { ...CONFIG_DEFAULTS.buildLoop },
    slack: merged.slack ?? { ...CONFIG_DEFAULTS.slack },
    briefings: merged.briefings ?? { ...CONFIG_DEFAULTS.briefings },
    browser: merged.browser ?? { ...CONFIG_DEFAULTS.browser },
    onboarding: merged.onboarding ?? { ...CONFIG_DEFAULTS.onboarding },
    realworld: merged.realworld ?? { ...CONFIG_DEFAULTS.realworld },
    outreach: merged.outreach ?? { ...CONFIG_DEFAULTS.outreach },
    acquisition: merged.acquisition ?? { ...CONFIG_DEFAULTS.acquisition },
    delivery: merged.delivery ?? { ...CONFIG_DEFAULTS.delivery },
    contentCadence: merged.contentCadence ?? { ...CONFIG_DEFAULTS.contentCadence },
    actionContract: merged.actionContract ?? { ...CONFIG_DEFAULTS.actionContract },
    provisioning: merged.provisioning ?? { ...CONFIG_DEFAULTS.provisioning },
    ads: merged.ads ?? { ...CONFIG_DEFAULTS.ads },
    enterprise: merged.enterprise ?? { ...CONFIG_DEFAULTS.enterprise },
    hostedSites: merged.hostedSites ?? { ...CONFIG_DEFAULTS.hostedSites },
    social: merged.social ?? { ...CONFIG_DEFAULTS.social },
    finance: merged.finance ?? { ...CONFIG_DEFAULTS.finance },
    attribution: merged.attribution ?? { ...CONFIG_DEFAULTS.attribution },
    customerIdentity: merged.customerIdentity ?? { ...CONFIG_DEFAULTS.customerIdentity },
    sessionInjection: merged.sessionInjection ?? { ...CONFIG_DEFAULTS.sessionInjection },
    monetization: merged.monetization ?? { ...CONFIG_DEFAULTS.monetization },
    discovery: merged.discovery ?? { ...CONFIG_DEFAULTS.discovery },
    reach: merged.reach ?? { ...CONFIG_DEFAULTS.reach },
    seo: merged.seo ?? { ...CONFIG_DEFAULTS.seo },
    analytics: merged.analytics ?? { ...CONFIG_DEFAULTS.analytics },
    agentRegistry: merged.agentRegistry ?? { ...CONFIG_DEFAULTS.agentRegistry },
    agentCollaboration: merged.agentCollaboration ?? { ...CONFIG_DEFAULTS.agentCollaboration },
    agentChannelPosting: merged.agentChannelPosting ?? { ...CONFIG_DEFAULTS.agentChannelPosting },
    garden: merged.garden ?? { ...CONFIG_DEFAULTS.garden },
    worktreePool: merged.worktreePool ?? { ...CONFIG_DEFAULTS.worktreePool },
    openDesign: merged.openDesign ?? { ...CONFIG_DEFAULTS.openDesign },
    connectClaude: merged.connectClaude ?? { ...CONFIG_DEFAULTS.connectClaude },
    connectOnce: merged.connectOnce ?? { ...CONFIG_DEFAULTS.connectOnce },
    capabilityTokens: merged.capabilityTokens ?? { ...CONFIG_DEFAULTS.capabilityTokens },
    skillopt: merged.skillopt ?? { ...CONFIG_DEFAULTS.skillopt },
    ozLoops: merged.ozLoops ?? { ...CONFIG_DEFAULTS.ozLoops },
    department: merged.department ?? { ...CONFIG_DEFAULTS.department },
    durableWorkflow: merged.durableWorkflow ?? { ...CONFIG_DEFAULTS.durableWorkflow },
    signupEntry: merged.signupEntry ?? { ...CONFIG_DEFAULTS.signupEntry },
    emailDeliverability: merged.emailDeliverability ?? { ...CONFIG_DEFAULTS.emailDeliverability },
    autonomousSend: merged.autonomousSend ?? { ...CONFIG_DEFAULTS.autonomousSend },
  };
}
