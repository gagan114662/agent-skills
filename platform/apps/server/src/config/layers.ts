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
    // #189 acquisition policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // real-send flags / auto-send switch / send caps cannot be loosened (e.g. real ads turned on, or a
    // window cap raised) by a lower layer.
    if (layer.acquisition !== undefined) out.acquisition = { ...layer.acquisition };
    // #194 finance policy: a higher (managed/owner) layer fully owns the block (replace) so the
    // ledger/close tick + the read surface cannot be flipped on by a lower layer — owner-workspace-first.
    if (layer.finance !== undefined) out.finance = { ...layer.finance };
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
    insight: merged.insight ?? { ...CONFIG_DEFAULTS.insight },
    moat: merged.moat ?? { ...CONFIG_DEFAULTS.moat },
    voice: merged.voice ?? { ...CONFIG_DEFAULTS.voice },
    supportDesk: merged.supportDesk ?? { ...CONFIG_DEFAULTS.supportDesk },
    legal: merged.legal ?? { ...CONFIG_DEFAULTS.legal },
    portfolio: merged.portfolio ?? { ...CONFIG_DEFAULTS.portfolio },
    planning: merged.planning ?? { ...CONFIG_DEFAULTS.planning },
    ventureMemory: merged.ventureMemory ?? { ...CONFIG_DEFAULTS.ventureMemory },
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
    acquisition: merged.acquisition ?? { ...CONFIG_DEFAULTS.acquisition },
    finance: merged.finance ?? { ...CONFIG_DEFAULTS.finance },
  };
}
