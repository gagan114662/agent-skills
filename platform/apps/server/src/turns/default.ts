import { getAgentSessionResult } from "../db/repositories/agent-sessions.js";
import {
  createPlanProposal,
  getPlanProposal,
  decidePlanProposal,
} from "../db/repositories/plan-proposals.js";
import {
  createSessionTurn,
  listSessionTurns,
  nextTurnIdx,
  markTurnsReverted,
} from "../db/repositories/session-turns.js";
import { latestMessageId, softDeleteMessagesAfter } from "../db/repositories/messages.js";
import type { SessionManager } from "../runtime/manager.js";
import type { GitWorkspaceService } from "../git/workspace.js";
import { TurnController, type TurnGit } from "./controller.js";

/**
 * Build the production {@link TurnController} (#53) over the shared SessionManager + the opt-in #51
 * GitWorkspaceService + the real repos. When no git repo is configured, `git` is null and the
 * checkpoint/revert routes return 501 — plan mode and steering need no repo.
 */
export function createTurnController(
  sessionManager: SessionManager,
  gitWorkspace: GitWorkspaceService | null,
): TurnController {
  const git: TurnGit | null = gitWorkspace
    ? {
        currentHeadSha: (key) => gitWorkspace.currentHeadSha(key),
        commitTurn: (key, message) => gitWorkspace.commitTurn(key, message),
        resetTo: (key, sha) => gitWorkspace.resetTo(key, sha),
      }
    : null;

  return new TurnController({
    launcher: {
      launch: (input) => sessionManager.launch(input),
      join: (id) => sessionManager.join(id),
    },
    sessionResult: (sessionId) => getAgentSessionResult(sessionId),
    git,
    createProposal: (input) => createPlanProposal(input),
    getProposal: (id, channelId) => getPlanProposal(id, channelId),
    decideProposal: (id, fields) => decidePlanProposal(id, fields),
    nextTurnIdx: (sessionId) => nextTurnIdx(sessionId),
    createTurn: (input) => createSessionTurn(input),
    listTurns: (sessionId, opts) => listSessionTurns(sessionId, opts),
    markTurnsReverted: (ids) => markTurnsReverted(ids),
    latestMessageId: (channelId) => latestMessageId(channelId),
    softDeleteMessagesAfter: (channelId, after) => softDeleteMessagesAfter(channelId, after),
  });
}
