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
    // #119 gate-pricing policy: a higher layer fully owns the block (replace) so a managed-layer
    // tenant's pricer flag / rails cannot be loosened (e.g. auto-relax turned off) by a lower layer.
    if (layer.gatePricing !== undefined) out.gatePricing = { ...layer.gatePricing };
    // #117 flywheel policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // self-healing flag / bounds (rate limit, concurrency cap) cannot be loosened by a lower layer.
    if (layer.flywheel !== undefined) out.flywheel = { ...layer.flywheel };
    // #123 marketing policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // seed-on-signup flag cannot be flipped on/off by a lower layer.
    if (layer.marketing !== undefined) out.marketing = { ...layer.marketing };
    // #102 growth policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // growth flag / traffic floor cannot be loosened by a lower layer.
    if (layer.growth !== undefined) out.growth = { ...layer.growth };
    // #100 insight policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // mining flag / cost cap / source cut cannot be loosened (e.g. mining turned off) by a lower layer.
    if (layer.insight !== undefined) out.insight = { ...layer.insight };
    // #103 moat policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // stagnation flagging / weights cannot be loosened (e.g. flagging turned off) by a lower layer.
    if (layer.moat !== undefined) out.moat = { ...layer.moat };
    // #115 planning policy: a higher layer fully owns the block (replace) so a managed-layer tenant's
    // planning flag / effort ceiling / dispatch caps cannot be loosened by a lower layer.
    if (layer.planning !== undefined) out.planning = { ...layer.planning };
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
    scale: merged.scale ?? { ...CONFIG_DEFAULTS.scale },
    // #98: no default billing settings — absent means billing is not enabled (inbound routes → 409).
    billing: merged.billing,
    venture: merged.venture ?? { ...CONFIG_DEFAULTS.venture },
    watchdog: merged.watchdog ?? { ...CONFIG_DEFAULTS.watchdog },
    sre: merged.sre ?? { ...CONFIG_DEFAULTS.sre },
    gatePricing: merged.gatePricing ?? { ...CONFIG_DEFAULTS.gatePricing },
    flywheel: merged.flywheel ?? { ...CONFIG_DEFAULTS.flywheel },
    marketing: merged.marketing ?? { ...CONFIG_DEFAULTS.marketing },
    growth: merged.growth ?? { ...CONFIG_DEFAULTS.growth },
    insight: merged.insight ?? { ...CONFIG_DEFAULTS.insight },
    moat: merged.moat ?? { ...CONFIG_DEFAULTS.moat },
    planning: merged.planning ?? { ...CONFIG_DEFAULTS.planning },
  };
}
