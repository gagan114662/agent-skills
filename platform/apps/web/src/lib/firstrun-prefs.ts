/**
 * Per-user persistence for the first-run setup checklist (#505). The checklist is a UI nudge, so its
 * dismissed / docked state lives in localStorage keyed by workspace — pressing Hide, or docking it to its
 * compact bar, sticks across reloads and channel switches for that user on that browser, with no server
 * round-trip. Reads and writes are defensive: missing or blocked storage and malformed JSON fall back to
 * defaults and never throw, so the console always renders even where localStorage is unavailable (private
 * mode, SSR, tests).
 */

export interface FirstRunPrefs {
  /** The user pressed Hide — the checklist should not show again for this user. */
  dismissed: boolean;
  /** The user docked the checklist to its compact bar so it doesn't take over the message area. */
  collapsed: boolean;
}

const DEFAULT_PREFS: FirstRunPrefs = { dismissed: false, collapsed: false };

function storageKey(workspaceId: string): string {
  return `reload.firstrun.${workspaceId}`;
}

/** The localStorage handle, or null when it is unavailable or access throws (storage blocked, SSR). */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read the checklist prefs for a workspace. Defaults (nothing dismissed/collapsed) on any miss or error. */
export function loadFirstRunPrefs(workspaceId: string | null | undefined): FirstRunPrefs {
  if (!workspaceId) return { ...DEFAULT_PREFS };
  const store = safeStorage();
  if (!store) return { ...DEFAULT_PREFS };
  try {
    const raw = store.getItem(storageKey(workspaceId));
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<FirstRunPrefs>;
    return { dismissed: parsed.dismissed === true, collapsed: parsed.collapsed === true };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist the checklist prefs for a workspace. A no-op when storage is unavailable; never throws. */
export function saveFirstRunPrefs(workspaceId: string | null | undefined, prefs: FirstRunPrefs): void {
  if (!workspaceId) return;
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(
      storageKey(workspaceId),
      JSON.stringify({ dismissed: prefs.dismissed, collapsed: prefs.collapsed }),
    );
  } catch {
    // Storage full or blocked — a non-persisted dismiss is acceptable; never break the UI.
  }
}
