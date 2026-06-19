import type { SessionInjectionConfig } from "../../config/schema.js";

/**
 * Resolve the browser session-injection policy (#388, ADR-0388) from the layered config (#58), applying
 * hard defaults — mirrors `attribution/caps.ts`. **Default OFF, owner-workspace-first**: a deployment
 * that sets no `sessionInjection` block never resolves a stored session, so `browser.newContext()` stays
 * authless (today's byte-for-byte behavior). When (and only when) this is active for a workspace does the
 * manager consult the {@link ../runtime/browser/session-store.BrowserSessionResolver} and inject the
 * per-workspace logged-in `storageState`. The injected session is a SECRET (vault-stored); this flag only
 * decides WHETHER to inject it — the SUBMIT/post action it enables stays #13-gated (ADR-0174 unchanged).
 */
export interface SessionInjectionCaps {
  /** Master flag for resolving + injecting a stored logged-in browser session. OFF by default. */
  enabled: boolean;
  /** The owner workspace this is active for (fail-closed: unset ⇒ nobody, like #386 attribution). */
  ownerWorkspaceId: string | null;
}

export const SESSION_INJECTION_DEFAULTS: SessionInjectionCaps = {
  enabled: false,
  ownerWorkspaceId: null,
};

export function resolveSessionInjectionCaps(
  cfg: SessionInjectionConfig | undefined,
): SessionInjectionCaps {
  return {
    enabled: cfg?.enabled ?? SESSION_INJECTION_DEFAULTS.enabled,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? SESSION_INJECTION_DEFAULTS.ownerWorkspaceId,
  };
}

/** Owner-workspace-first gate (fail-closed): only the named owner workspace may inject a session. */
export function isOwnerWorkspace(caps: SessionInjectionCaps, workspaceId: string): boolean {
  if (!caps.ownerWorkspaceId) return false;
  return caps.ownerWorkspaceId === workspaceId;
}

/** Convenience: session injection runs for this workspace iff enabled AND it is the owner workspace. */
export function sessionInjectionActive(caps: SessionInjectionCaps, workspaceId: string): boolean {
  return caps.enabled && isOwnerWorkspace(caps, workspaceId);
}
