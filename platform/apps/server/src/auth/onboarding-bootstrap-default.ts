import type { FastifyBaseLogger } from "fastify";
import type { SessionManager } from "../runtime/manager.js";
import { seedDepartmentForWorkspace, createMarketingBriefService } from "../marketing/default.js";
import {
  setWorkspaceDomain,
  markWorkspaceBootstrapped,
} from "../db/repositories/workspace-onboarding.js";
import {
  bootstrapAfterGoogleSignin,
  type OnboardingBootstrapDeps,
  type OnboardingBootstrapInput,
} from "./onboarding-bootstrap.js";

/**
 * Production wiring for the #260 post-signin bootstrap (kept out of the pure module so unit tests don't
 * drag in the runtime/marketing graph). Seeds via the SAME explicit seam the `/department/seed` route uses
 * (welcome-session spend off), and briefs Scout through the #235 brief service over the shared
 * SessionManager. Returns the bound bootstrap function the Google callback invokes.
 */
export function makeDefaultOnboardingBootstrap(
  sessionManager: SessionManager,
  log: FastifyBaseLogger,
): (input: OnboardingBootstrapInput) => Promise<void> {
  const briefService = createMarketingBriefService(sessionManager);
  const deps: OnboardingBootstrapDeps = {
    setDomain: setWorkspaceDomain,
    markBootstrapped: markWorkspaceBootstrapped,
    seedFleet: async ({ workspaceId, memberId }) => {
      await seedDepartmentForWorkspace(sessionManager, {
        workspaceId,
        createdByMemberId: memberId,
        welcomeTasks: false,
      });
    },
    briefScout: async ({ workspaceId, memberId, goal }) => {
      const result = await briefService.brief({ workspaceId, memberId }, { lead: "scout", goal });
      if (!result.ok) {
        log.error(
          { reason: result.error, code: result.code },
          "onboarding Scout brief was not launched",
        );
      }
    },
    log,
  };
  return (input) => bootstrapAfterGoogleSignin(deps, input);
}
