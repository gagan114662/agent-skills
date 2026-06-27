import type { FastifyBaseLogger } from "fastify";

/**
 * The post-signin bootstrap for #260: after the single Google consent the user must land on a WORKING
 * board with nothing left to do. So we (1) persist the domain they typed, (2) stand up the department
 * fleet so Scout exists, (3) kick Scout to verify the domain + submit the sitemap against the now-connected
 * Google account, and (4) mark the workspace bootstrapped so a re-login never re-fires it.
 *
 * Every step is best-effort: a failure in any one must NOT block the user from reaching the board (they're
 * already signed in). The Scout brief reuses the audited #235 @mention launch path — no new authority — and
 * the verify/sitemap work itself is the GSC connector's job (#258); here we only trigger it.
 */

export interface OnboardingBootstrapDeps {
  setDomain(workspaceId: string, domain: string): Promise<void>;
  seedFleet(input: { workspaceId: string; memberId: string }): Promise<void>;
  briefScout(input: { workspaceId: string; memberId: string; goal: string }): Promise<void>;
  recordFirstRunReceipt(input: {
    workspaceId: string;
    target: string;
    finding: string;
    artifactTitle: string;
    artifactSummary: string;
    receipt: string;
  }): Promise<void>;
  markBootstrapped(workspaceId: string): Promise<void>;
  log?: Pick<FastifyBaseLogger, "error">;
}

export interface OnboardingBootstrapInput {
  workspaceId: string;
  memberId: string;
  domain: string;
  siteUrl: string;
}

/** The brief Scout receives — owner-derived data behind the fixed `@scout` structural prefix (injection-safe). */
export function scoutVerifyGoal(siteUrl: string): string {
  return (
    `Verify ${siteUrl} in Google Search Console using the connected Google account, ` +
    `submit its sitemap (${siteUrl}/sitemap.xml), request indexing for the homepage, ` +
    `then report coverage. The Google account is already connected — no further setup is needed.`
  );
}

export function bootstrapFirstRunReceipt(input: OnboardingBootstrapInput): {
  workspaceId: string;
  target: string;
  finding: string;
  artifactTitle: string;
  artifactSummary: string;
  receipt: string;
} {
  const goal = scoutVerifyGoal(input.siteUrl);
  return {
    workspaceId: input.workspaceId,
    target: input.domain,
    finding:
      "Scout has the connected Google account brief for " +
      input.siteUrl +
      ": verify Search Console, submit the sitemap, request homepage indexing, and report coverage.",
    artifactTitle: "first-run Scout brief queued",
    artifactSummary: goal,
    receipt: "Google sign-in bootstrap queued Scout for " + input.domain,
  };
}

async function step(
  label: string,
  fn: () => Promise<void>,
  log?: Pick<FastifyBaseLogger, "error">,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log?.error({ err, step: label }, "onboarding bootstrap step failed");
  }
}

export async function bootstrapAfterGoogleSignin(
  deps: OnboardingBootstrapDeps,
  input: OnboardingBootstrapInput,
): Promise<void> {
  await step("setDomain", () => deps.setDomain(input.workspaceId, input.domain), deps.log);
  // Seed first so the Scout channel/persona exists before we brief it (the brief 409s otherwise).
  await step(
    "seedFleet",
    () => deps.seedFleet({ workspaceId: input.workspaceId, memberId: input.memberId }),
    deps.log,
  );
  await step(
    "briefScout",
    () =>
      deps.briefScout({
        workspaceId: input.workspaceId,
        memberId: input.memberId,
        goal: scoutVerifyGoal(input.siteUrl),
      }),
    deps.log,
  );
  await step(
    "recordFirstRunReceipt",
    () => deps.recordFirstRunReceipt(bootstrapFirstRunReceipt(input)),
    deps.log,
  );
  await step("markBootstrapped", () => deps.markBootstrapped(input.workspaceId), deps.log);
}
