/**
 * Venture-intake surface flag (#387, ADR-0387) — a PURE, default-OFF, owner-workspace-first gate that
 * mirrors the BACKEND `ventureIntake` config shape (and the #352 coordination flag) entirely on the web.
 *
 * Why a web flag: the #96 venture loop intake (submit → score → fund → epic) is already built and live on
 * the server, but there is no console surface to brief a company idea into it. This flag lets us mount the
 * "Brief a venture" panel for ONE named workspace (the owner's), to validate the surface before any broad
 * rollout. The SERVER also gates the submit route behind its own default-OFF `ventureIntake` flag, so even
 * if this web flag were on without the server flag, the POST answers 409 — fail-closed on both sides.
 *
 * Two invariants, both matching the backend's safest default:
 *   - DEFAULT-OFF  — env unset ⇒ flag off ⇒ the panel renders for nobody.
 *   - OWNER-FIRST  — even when on, the panel shows ONLY for the named owner workspace; naming nobody (no
 *                    owner id) shows it to nobody.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_RELOAD_VENTURE_INTAKE=true|1`. Default OFF (any other / unset ⇒ off). */
export const VENTURE_INTAKE_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_VENTURE_INTAKE);
  return raw === "true" || raw === "1";
})();

/** The owner's own workspace id (the owner-first rollout marker) — `VITE_RELOAD_VENTURE_INTAKE_OWNER_WORKSPACE_ID`. */
export const VENTURE_INTAKE_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_RELOAD_VENTURE_INTAKE_OWNER_WORKSPACE_ID,
);

export interface VentureIntakeGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** The owner's workspace id (owner-first marker); empty/unset ⇒ nobody. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the venture-brief panel shows. PURE so every branch is unit-tested without a DOM. The rule
 * is the backend owner-workspace-first contract expressed on the web:
 *
 *   off flag ⇒ no · no current workspace ⇒ no · no named owner ⇒ no (named nobody = nobody) ·
 *   otherwise show ONLY when the current workspace IS the named owner.
 *
 * Fail-closed at every branch.
 */
export function shouldShowVentureIntake(input: VentureIntakeGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}
