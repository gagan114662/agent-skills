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
  };
}
