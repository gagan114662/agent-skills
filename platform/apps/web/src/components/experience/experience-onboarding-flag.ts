/**
 * ipop experience-system onboarding flag (#784). The visual/system work is intentionally owner-first and
 * default-OFF so the current console stays unchanged until the design surface is ready to dogfood.
 */

const env = import.meta.env;

function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch: `VITE_IPOP_EXPERIENCE_ONBOARDING=true|1`. Default OFF. */
export const IPOP_EXPERIENCE_ONBOARDING_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_IPOP_EXPERIENCE_ONBOARDING);
  return raw === "true" || raw === "1";
})();

/** Owner workspace marker: `VITE_IPOP_EXPERIENCE_OWNER_WORKSPACE_ID`. Empty means nobody. */
export const IPOP_EXPERIENCE_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_IPOP_EXPERIENCE_OWNER_WORKSPACE_ID,
);

export interface ExperienceOnboardingGateInput {
  readonly flagOn: boolean;
  readonly ownerWorkspaceId?: string | null | undefined;
  readonly workspaceId?: string | null | undefined;
}

export function shouldShowExperienceOnboarding(input: ExperienceOnboardingGateInput): boolean {
  if (!input.flagOn) return false;
  const workspace = input.workspaceId?.trim();
  if (!workspace) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return workspace === owner;
}
