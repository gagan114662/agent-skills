/**
 * Everyday-workspace-shell flag (#784) — a PURE gate that turns on the redesigned "everyday shell": the
 * linzumi-calm, chat-first surface with the cheeky Innocent voice. It is a VISUAL redesign of the logged-in
 * workspace; this governs only the web shell the signed-in member sees (no backend flag is flipped here).
 *
 * #784 GO-LIVE: the redesign is now the production default for the signed-in workspace:
 *   · DEFAULT-ON   — env unset ⇒ flag on. Only "false"/"0" turns it off (restoring today's console).
 *   · FULL ROLLOUT — the shell shows for ANY signed-in workspace. The only fail-closed branches are an
 *                    explicitly-off flag and a missing current workspace (the shell is a logged-in surface).
 *
 * Reversible: set VITE_EVERYDAY_SHELL=false and the default console renders unchanged.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_EVERYDAY_SHELL`. Default ON; only "false"/"0" turns it off (#784 go-live). */
export const EVERYDAY_SHELL_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_EVERYDAY_SHELL);
  return raw !== "false" && raw !== "0";
})();

/** Deprecated owner-first rollout marker. Kept readable so stale deploy env cannot crash the bundle. */
export const EVERYDAY_SHELL_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_EVERYDAY_SHELL_OWNER_WORKSPACE_ID,
);

/**
 * Internal-view flag (#1533) — `VITE_EVERYDAY_INTERNAL`. DEFAULT-OFF, opt-in: only "true"/"1" turns it on.
 *
 * The everyday dashboard is a customer surface. Its build receipts ("first-run receipt persisted", "no
 * external transparency receipt created", "no provider receipt connected") are honest internal proof, but
 * they read as insider jargon to a customer who has never seen ipop. This flag decides whether those internal
 * proof/receipt lines are rendered: OFF (the customer default) shows the plain metric + its one-sentence
 * explanation; ON (an internal / dogfooding session) also shows the underlying proof receipt behind each number.
 *
 * It does NOT hide the live/sample/external honesty chip — that label protects the customer from mistaking
 * sample traction for live results, so it stays visible in both modes.
 */
export const EVERYDAY_INTERNAL_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_EVERYDAY_INTERNAL);
  return raw === "true" || raw === "1";
})();

export interface EverydayShellGateInput {
  /** The master flag (default ON). */
  readonly flagOn: boolean;
  /** Deprecated; the #784 go-live is no longer narrowed by owner workspace. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id (the shell is a logged-in surface). */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the everyday shell shows. PURE so every branch is unit-tested without a DOM. #784 go-live
 * rule — full rollout, fail-closed only where it must be:
 *
 *   off flag ⇒ no · no current workspace ⇒ no · otherwise show for ANY signed-in workspace.
 *
 * The only paths that hide the shell are an explicitly-off flag and a missing current workspace.
 */
export function shouldShowEverydayShell(input: EverydayShellGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  return true;
}
