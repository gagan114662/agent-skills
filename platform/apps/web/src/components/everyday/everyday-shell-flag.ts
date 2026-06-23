/**
 * Everyday-workspace-shell flag (#784) — a PURE, default-OFF, owner-workspace-first gate that turns on the
 * redesigned "everyday shell": the linzumi-calm, chat-first surface with the cheeky Innocent voice. It is a
 * VISUAL redesign of the logged-in workspace, gated exactly like the coordination surface (#352) so that
 * production — which sets no such env — renders byte-for-byte today's console, and the owner can validate
 * the new shell on their own deployment/preview before any broad rollout.
 *
 * Two invariants, both matching the safest backend default (agentRegistry #282 / coordination #352):
 *   · DEFAULT-OFF  — env unset ⇒ flag off ⇒ the shell shows for nobody.
 *   · OWNER-FIRST — even when on, the shell shows ONLY for the named owner workspace; naming nobody (no
 *                   owner id) shows it to nobody ("turning it on without naming the owner provisions it for
 *                   nobody"). Fail-closed at every branch.
 *
 * Reversible: unset the env and the redesign is gone; the default console renders unchanged. No backend
 * flag is flipped here — this governs only the web shell the owner sees.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_EVERYDAY_SHELL=true|1`. Default OFF (any other / unset ⇒ off). */
export const EVERYDAY_SHELL_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_EVERYDAY_SHELL);
  return raw === "true" || raw === "1";
})();

/** The owner's own workspace id (the owner-first rollout marker) — `VITE_EVERYDAY_SHELL_OWNER_WORKSPACE_ID`. */
export const EVERYDAY_SHELL_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_EVERYDAY_SHELL_OWNER_WORKSPACE_ID,
);

export interface EverydayShellGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** The owner's workspace id (owner-first marker); empty/unset ⇒ nobody. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the everyday shell shows. PURE so every branch is unit-tested without a DOM. The rule is
 * owner-workspace-first, fail-closed:
 *
 *   off flag ⇒ no · no current workspace ⇒ no · no named owner ⇒ no (named nobody = nobody) ·
 *   otherwise show ONLY when the current workspace IS the named owner.
 *
 * There is no path where an off flag, a missing workspace, or an unnamed owner reveals the shell.
 */
export function shouldShowEverydayShell(input: EverydayShellGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}
