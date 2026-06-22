/**
 * Configuration for the AI UGC avatar studio (issue #741). Deliberately **self-contained**: every tunable is read
 * straight from the process environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and
 * stays free of parallel-merge conflicts with sibling branches (the proven #670/#674/#272 pattern).
 *
 * Two INDEPENDENT default-OFF guards, defense in depth (rendering avatars can spend money on an external render
 * API and is outward-facing creative):
 *   - `enabled` (default false) + `ownerWorkspaceOnly` (default true): the studio rolls out owner-workspace-first,
 *     exactly like `ads`/`provisioning`/`delivery`. A deployment that sets nothing offers no studio at all.
 *   - The provider seam itself defaults to the deterministic {@link FakeAvatarProvider}: even when `enabled`, NO
 *     external call is made until a deployment also wires a live provider. "No external calls until enabled" holds.
 *
 * Pure given its `env` argument ⇒ unit-testable; the IO (Postgres) lives in `default.ts`.
 */

export interface AvatarStudioCaps {
  /** Master flag for the avatar studio. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, the studio is offered ONLY for `ownerWorkspaceId`;
   * set false to broaden to all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the studio dogfoods here first, or null. */
  ownerWorkspaceId: string | null;
}

export const AVATAR_STUDIO_DEFAULTS: AvatarStudioCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
};

/** Parse a boolean env flag: only an explicit truthy token enables it; anything else (incl. missing) ⇒ false. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/** Trim an optional env string to a non-empty value, or null. */
function parseOptional(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolve the caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveAvatarStudioCaps(env: NodeJS.ProcessEnv = process.env): AvatarStudioCaps {
  return {
    enabled: parseBool(env.AVATAR_STUDIO_ENABLED, AVATAR_STUDIO_DEFAULTS.enabled),
    ownerWorkspaceOnly: parseBool(
      env.AVATAR_STUDIO_OWNER_WORKSPACE_ONLY,
      AVATAR_STUDIO_DEFAULTS.ownerWorkspaceOnly,
    ),
    ownerWorkspaceId: parseOptional(env.AVATAR_STUDIO_OWNER_WORKSPACE_ID),
  };
}

/**
 * Pure + total + fail-closed: is the studio in scope for this workspace? Disabled ⇒ never; owner-first ⇒ ONLY
 * the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody in, never everybody — the safest
 * default, matching `ads`/`provisioning`/`delivery`).
 */
export function isAvatarStudioEnabledForWorkspace(caps: AvatarStudioCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
