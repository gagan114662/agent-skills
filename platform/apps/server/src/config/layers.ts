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
  };
}
