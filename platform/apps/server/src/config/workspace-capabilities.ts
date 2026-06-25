import { loadConfig, type ConfigSources } from "./loader.js";
import type { ResolvedConfig } from "./schema.js";
import {
  listWorkspaceCapabilities,
  type WorkspaceCapabilityRow,
} from "../db/repositories/workspace-capabilities.js";

export function applyWorkspaceCapabilityOverrides(
  config: ResolvedConfig,
  capabilities: WorkspaceCapabilityRow[],
): ResolvedConfig {
  const out: ResolvedConfig = {
    ...config,
    marketing: { ...config.marketing },
    onboarding: { ...config.onboarding },
    realworld: { ...config.realworld },
  };
  for (const capability of capabilities) {
    if (capability.capability === "marketing") out.marketing.enabled = capability.enabled;
    if (capability.capability === "onboarding") out.onboarding.enabled = capability.enabled;
    if (capability.capability === "realworld") out.realworld.enabled = capability.enabled;
  }
  return out;
}

export async function loadWorkspaceConfig(
  workspaceId: string,
  sources?: ConfigSources,
): Promise<ResolvedConfig> {
  const [base, capabilities] = await Promise.all([
    Promise.resolve(loadConfig(workspaceId, sources)),
    listWorkspaceCapabilities(workspaceId),
  ]);
  return applyWorkspaceCapabilityOverrides(base, capabilities);
}

