/**
 * Short-form Blitz + content-calendar surface flag (#744). Pure, default-OFF, owner-workspace-first, and
 * intentionally shaped like the existing console gates so the surface is provisioned for nobody unless a
 * deployment opts in AND names the owner workspace.
 */

const env = import.meta.env;

function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_RELOAD_SHORT_FORM_BLITZ=true|1`. Default OFF (unset / anything else ⇒ off). */
export const SHORT_FORM_BLITZ_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_SHORT_FORM_BLITZ);
  return raw === "true" || raw === "1";
})();

/** Owner workspace marker — `VITE_RELOAD_SHORT_FORM_BLITZ_OWNER_WORKSPACE_ID`. Empty means nobody. */
export const SHORT_FORM_BLITZ_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_RELOAD_SHORT_FORM_BLITZ_OWNER_WORKSPACE_ID,
);

export interface ShortFormBlitzGateInput {
  readonly flagOn: boolean;
  readonly ownerWorkspaceId?: string | null | undefined;
  readonly workspaceId?: string | null | undefined;
}

export function shouldShowShortFormBlitz(input: ShortFormBlitzGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}
