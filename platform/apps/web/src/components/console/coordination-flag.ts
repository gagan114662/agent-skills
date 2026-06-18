/**
 * Agent-coordination surface flag (#352) — a PURE, default-OFF, owner-workspace-first gate that mirrors the
 * BACKEND owner-workspace-first config shape (agentRegistry #282 / agentCollaboration #319 / durableWorkflow
 * #338) entirely on the web with ZERO new backend.
 *
 * Why a web flag at all: the reload.chat-style coordination components (ChannelSidebar / MessagePane /
 * MembersRail / ThreadPanel / MissionControlPanel) already exist but are imported by nothing — they are dead
 * code (the live app renders only the board, ConsoleView). This flag lets us re-mount them as a real
 * coordination view for ONE named workspace (the owner's), to validate the surface before any broad rollout,
 * WITHOUT flipping a single production backend flag.
 *
 * Two invariants, both matching the backend's safest default:
 *   · DEFAULT-OFF  — env unset ⇒ flag off ⇒ the surface renders for nobody.
 *   · OWNER-FIRST — even when on, the surface shows ONLY for the named owner workspace; naming nobody (no
 *                   owner id) shows it to nobody ("turning it on without naming ownerWorkspaceId provisions
 *                   it for nobody" — the agentRegistry/agentCollaboration/durableWorkflow contract).
 *
 * This is the WEB half. The BACKEND managed-layer enablement SEQUENCE (A2A → collaboration → durable) and the
 * exact server config keys live in ADR-0352; this PR flips nothing in production.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_RELOAD_COORDINATION_UI=true|1`. Default OFF (any other / unset ⇒ off). */
export const COORDINATION_UI_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_COORDINATION_UI);
  return raw === "true" || raw === "1";
})();

/** The owner's own workspace id (the owner-first rollout marker) — `VITE_RELOAD_COORDINATION_OWNER_WORKSPACE_ID`. */
export const COORDINATION_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_RELOAD_COORDINATION_OWNER_WORKSPACE_ID,
);

export interface CoordinationGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** The owner's workspace id (owner-first marker); empty/unset ⇒ nobody. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the coordination surface shows. PURE so every branch is unit-tested without a DOM. The rule
 * is the backend owner-workspace-first contract expressed on the web:
 *
 *   off flag ⇒ no · no current workspace ⇒ no · no named owner ⇒ no (named nobody = nobody) ·
 *   otherwise show ONLY when the current workspace IS the named owner.
 *
 * Fail-closed at every branch — there is no path where an unnamed owner, a missing workspace, or an off flag
 * reveals the surface.
 */
export function shouldShowCoordination(input: CoordinationGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}
