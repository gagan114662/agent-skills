/**
 * Per-user workspace/channel selection persistence (#650). The app currently has one workspace per account,
 * with the channel acting as the user's selected work context inside that workspace. Keep that selection local,
 * scoped by workspace and member, and treat storage as best-effort so blocked/local-less environments still
 * boot normally.
 */

const PREFIX = "reload.workspaceSelection";

function storageKey(workspaceId: string, memberId: string): string {
  return `${PREFIX}.${workspaceId}.${memberId}`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadWorkspaceSelection(
  workspaceId: string | null | undefined,
  memberId: string | null | undefined,
): string | null {
  if (!workspaceId || !memberId) return null;
  const store = safeStorage();
  if (!store) return null;
  try {
    const value = store.getItem(storageKey(workspaceId, memberId));
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceSelection(
  workspaceId: string | null | undefined,
  memberId: string | null | undefined,
  channelId: string | null | undefined,
): void {
  if (!workspaceId || !memberId || !channelId) return;
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(storageKey(workspaceId, memberId), channelId);
  } catch {
    // Storage full/blocked should never make workspace navigation fail.
  }
}
