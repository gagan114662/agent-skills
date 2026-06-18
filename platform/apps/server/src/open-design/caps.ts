import type { OpenDesignConfig } from "../config/schema.js";

/**
 * Open-Design caps (#353, ADR-0353) — pure policy for whether the brand department (@mark) and the
 * other creative leads may *offer* the third-party `open-design` desktop app for real brand-asset
 * generation (logo / brand-kit, social + ad creative, slide decks) in a given workspace. Mirrors
 * `worktree-pool/caps.ts` / `garden/caps.ts`: a two-pronged gate that is **default OFF** and
 * **owner-workspace-first**, resolved with hard defaults from the layered config.
 *
 * open-design is a HEAVYWEIGHT, third-party (Apache-2.0), local-first desktop app + `od` CLI that the
 * owner installs by hand. This flag NEVER installs anything and is not a runtime integration — it is
 * purely a permission marker for which workspace may surface the tool in guidance. It ships OFF and
 * dogfoods on the owner's own workspace first; a deployment that sets nothing keeps today's draft-only
 * behavior exactly, so behavior is unchanged (#200 §3/§4). Even when enabled, every irreversible /
 * publish / money action a generated asset feeds still routes through the #13 approval gate, and any
 * generated asset/metadata is untrusted DATA, never instructions (#200 §6).
 */
export interface OpenDesignCaps {
  /** Offer open-design for real-asset generation to the brand/creative leads. OFF by default. */
  enabled: boolean;
  /**
   * Roll the offer out owner-workspace-first (default true): even when `enabled`, an
   * `ownerWorkspaceOnly` deployment only offers it in `ownerWorkspaceId`; every other tenant keeps
   * today's draft-only path. Set false to offer it to all tenants once the owner has proven the path.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the offer dogfoods here first. */
  ownerWorkspaceId: string | undefined;
}

export const OPEN_DESIGN_DEFAULTS: OpenDesignCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
};

/** Resolve the open-design caps from the layered config, applying hard defaults. */
export function resolveOpenDesignCaps(cfg: OpenDesignConfig | undefined): OpenDesignCaps {
  return {
    enabled: cfg?.enabled ?? OPEN_DESIGN_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? OPEN_DESIGN_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? OPEN_DESIGN_DEFAULTS.ownerWorkspaceId,
  };
}

/**
 * Pure: may this specific workspace be OFFERED open-design (#353)? The capability rolls out
 * owner-workspace-first — so even when the master `enabled` flag is on, an `ownerWorkspaceOnly`
 * deployment (the default) only offers it in the named owner workspace, and every other tenant keeps
 * today's draft-only path. Turning `enabled` on WITHOUT naming the owner workspace offers it to nobody
 * (the safest default, matching `worktreePool`/`garden`/`agentCollaboration`). Set `ownerWorkspaceOnly`
 * false to offer to all once the owner has proven the path.
 */
export function isOpenDesignEnabledForWorkspace(
  caps: OpenDesignCaps,
  workspaceId: string,
): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
