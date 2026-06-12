import { loadConfig } from "../config/loader.js";
import { resolveBuildLoopCaps } from "./caps.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import {
  BuildLoopEngine,
  type BuildLauncher,
  type Escalator,
  type RepoHost,
  type Reviewer,
} from "./engine.js";
import { evaluateHouseRubric } from "./rubric.js";
import { issueNumberOf } from "./render.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import {
  buildLoopRunStore,
  buildLoopReviewStore,
  listActiveBuildLoopWorkspaces,
} from "../db/repositories/build-loop.js";
import { createRequest } from "../db/repositories/approvals.js";
import { listWorkspaceMembers } from "../db/repositories/members.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { makeRedactor } from "../runtime/redact.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for the Self-Shipping Loop (#172, ADR-0172). Default-OFF (config `buildLoop.enabled`
 * + `BUILDLOOP_INTERVAL_MS`), so wiring it changes nothing until an operator opts in. The repo host
 * defaults to a **no-op** (no GitHub credentials) so CI/tests never reach GitHub and a building run never
 * advances; a deployment injects a real `gh`-backed `RepoHost`. The reviewer defaults to the pure house
 * rubric (zero spend); escalations create a **pending** #13 request a human owns — never an auto-merge.
 */

/** The #13 action a self-shipping escalation is anchored under (the owner approves any out-of-guardrail step). */
export const BUILDLOOP_ESCALATE_ACTION = "buildloop.escalate";

/** The #92 launcher, adapted to launch a build/review/revise agent into the run's target channel/agent. */
function buildLauncherFrom(sessionManager: SessionManager): BuildLauncher {
  const launcher = autonomyLauncherFrom(sessionManager);
  return {
    launch: async ({ workspaceId, run, task, role }) => {
      if (!run.targetChannelId || !run.targetAgentMemberId) {
        // A run with no launch target can never auto-build — the operator supplies one (or it escalates).
        // Fail loud: the dispatch decision should never route such a run to a launch.
        throw new Error("build-loop: cannot launch a session for a run with no target channel/agent");
      }
      return launcher.launch({
        workspaceId,
        channelId: run.targetChannelId,
        agentMemberId: run.targetAgentMemberId,
        createdByMemberId: run.targetAgentMemberId,
        task,
        harnessEnv: { AGENT_BUILDLOOP_ROLE: role },
      });
    },
  };
}

/** The default reviewer: the pure house rubric over the PR diff (no model spend, deterministic). */
function rubricReviewer(): Reviewer {
  return {
    review: async ({ workspaceId, run, diff }) => {
      const caps = resolveBuildLoopCaps(loadConfig(workspaceId).buildLoop);
      return evaluateHouseRubric({
        issueNumber: issueNumberOf(run.issueRef),
        files: diff.files,
        addedLines: diff.addedLines,
        protectedPaths: caps.protectedPaths,
      });
    },
  };
}

/**
 * The no-credential repo host: observes no PR (so a building run never advances), and refuses every
 * mutating call. A deployment with `GITHUB_PROVIDER=gh` + a worktree repo injects a real implementation;
 * tests inject a fake. This keeps the loop wired-but-inert by default — exactly the #25 sandbox discipline.
 */
export function noopRepoHost(logger: SessionLogger): RepoHost {
  return {
    observePr: async () => null,
    getDiff: async () => ({ files: [], additions: 0, deletions: 0, addedLines: [] }),
    ciGreen: async () => false,
    comment: async ({ prRef }) => {
      logger.info({ prRef }, "build-loop (no-op repo): would post a reviewer verdict comment");
    },
    merge: async () => {
      throw new Error("build-loop: no repo host configured — cannot merge");
    },
    updateFromMain: async () => ({ conflicted: false }),
  };
}

/**
 * Resolve the #13 requester for an escalation: the run's target agent if set, else the workspace's first
 * human (the owner). `requester_member_id` is NOT NULL + FK to members (the SRE-loop gotcha), so a
 * target-less run still needs a real member to anchor the approval.
 */
async function resolveRequester(workspaceId: string, targetAgentMemberId: string | null): Promise<string> {
  if (targetAgentMemberId) return targetAgentMemberId;
  const members = await listWorkspaceMembers(workspaceId);
  const member = members.find((m) => m.kind === "human") ?? members[0];
  if (!member) throw new Error("build-loop: cannot escalate — workspace has no members");
  return member.id;
}

/** The owner-escalation seam: a pending #13 request (surfaced in the audit trail + #104 console). */
const escalator: Escalator = {
  escalate: async ({ workspaceId, run, reason, summary }) => {
    await createRequest({
      workspaceId,
      requesterMemberId: await resolveRequester(workspaceId, run.targetAgentMemberId),
      actionType: BUILDLOOP_ESCALATE_ACTION,
      payload: { runId: run.id, issueRef: run.issueRef, prRef: run.prRef, reason },
      amount: null,
      summary,
      status: "pending", // the owner decides — the loop never merges/reverts on its own
      expiresAt: null,
      events: [{ type: "requested", detail: { runId: run.id, reason } }],
    });
  },
};

/** Build the production BuildLoopEngine. The background timer is started in `index.ts`. */
export function createDefaultBuildLoopEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): BuildLoopEngine {
  return new BuildLoopEngine({
    runs: buildLoopRunStore,
    reviews: buildLoopReviewStore,
    repo: noopRepoHost(logger),
    launcher: buildLauncherFrom(sessionManager),
    reviewer: rubricReviewer(),
    escalator,
    caps: (workspaceId) => resolveBuildLoopCaps(loadConfig(workspaceId).buildLoop),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    budgetExhausted: async (workspaceId, now) =>
      budgetExceeded(
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
        resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
      ),
    // No event-scoped secrets at the engine layer; a real RepoHost/reviewer redacts session text at its
    // own seam. The default redactor is identity-with-no-secrets — review/escalation text is rubric-derived.
    redact: (text) => makeRedactor({})(text),
    activeWorkspaces: listActiveBuildLoopWorkspaces,
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}

export { resolveBuildLoopCaps };
