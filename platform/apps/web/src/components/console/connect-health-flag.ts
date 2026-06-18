/**
 * Connect-Claude health surface flag (#365) — a PURE, default-OFF, owner-workspace-first gate that
 * mirrors the BACKEND connectClaude (#262) owner-first config shape entirely on the web.
 *
 * Why a flag: surfacing a persistent "connected / not connected / token expired" chip in the console is a
 * visible change. The epic rail is owner-workspace-first — customer tenants stay byte-for-byte unchanged
 * until the owner opts in. The underlying `/me/claude/health` read is harmless for any workspace (it is the
 * caller's own state, never a secret); this flag only governs whether the CONSOLE renders the chip, so prod
 * (which sets no env) is byte-for-byte the board it is today. The manual paste path + the first-run
 * empty-state's Connect route are unconditional and always available regardless of this flag.
 *
 * Two invariants, both matching the backend's safest default:
 *   · DEFAULT-OFF  — env unset ⇒ off ⇒ the chip renders for nobody.
 *   · OWNER-FIRST  — even when on, it shows ONLY for the named owner workspace; naming nobody (no owner id)
 *                    shows it to nobody (fail-closed).
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_RELOAD_CONNECT_HEALTH_UI=true|1`. Default OFF (any other / unset ⇒ off). */
export const CONNECT_HEALTH_UI_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_CONNECT_HEALTH_UI);
  return raw === "true" || raw === "1";
})();

/** The owner's own workspace id (owner-first marker) — `VITE_RELOAD_CONNECT_HEALTH_OWNER_WORKSPACE_ID`. */
export const CONNECT_HEALTH_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_RELOAD_CONNECT_HEALTH_OWNER_WORKSPACE_ID,
);

export interface ConnectHealthGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** The owner's workspace id (owner-first marker); empty/unset ⇒ nobody. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the connection-health chip shows. PURE so every branch is unit-tested without a DOM.
 * Fail-closed at every branch: off flag ⇒ no · no current workspace ⇒ no · no named owner ⇒ no (named
 * nobody = nobody) · otherwise show ONLY when the current workspace IS the named owner.
 */
export function shouldShowConnectHealth(input: ConnectHealthGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}
