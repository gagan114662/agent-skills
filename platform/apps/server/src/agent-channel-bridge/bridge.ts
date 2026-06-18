/**
 * The agent→channel message bridge (#370, ADR-0370) — the missing seam that makes the coordination view
 * (#354) fill like reload.chat. Agent activity already flows to session logs, the board, PRs, and
 * mission-control; nothing posts a chat message. This dispatcher closes that gap: it takes a STRUCTURAL
 * coordination event, composes a text-only line, and posts it via the SAME `postMessage` write the REST
 * route uses — authored as the acting agent's (kind="agent") member row.
 *
 * Rails (#200 / epic #359):
 *   · DEFAULT-OFF, OWNER-FIRST — `isAgentChannelPostingEnabledForWorkspace` gates every post; an
 *     unconfigured deployment (the default) posts nothing, so prod channels stay byte-for-byte quiet.
 *   · FAIL-CLOSED + BEST-EFFORT — a missing channel, a missing/inactive agent member, or any thrown error
 *     yields a no-op result; the bridge NEVER throws into its caller (it sits on top of audited paths the
 *     way `deliverPostedMessage` does, never failing the underlying write).
 *   · NO NEW ACTION PATH — the `approval_required` post only SURFACES the existing #13 gate; the bridge
 *     performs no money/irreversible work and adds no authority. Content is DATA, rendered text-only.
 */
import type { AgentChannelPostingCaps } from "./caps.js";
import { isAgentChannelPostingEnabledForWorkspace } from "./caps.js";
import { composePost } from "./compose.js";
import type { BridgeResult, CoordinationEvent } from "./events.js";

export interface CoordinationBridgeDeps {
  /** Per-workspace posting caps (resolved from the layered config). */
  caps(workspaceId: string): AgentChannelPostingCaps;
  /** Resolve a department channel id by name in this workspace, or undefined (not seeded). */
  resolveChannelId(workspaceId: string, channelName: string): Promise<string | undefined>;
  /** Resolve an ACTIVE agent member by @handle (guarantees kind="agent"), or undefined. */
  resolveAgentMember(
    workspaceId: string,
    handle: string,
  ): Promise<{ memberId: string } | undefined>;
  /** The workspace owner's display name for an approval @mention, or undefined (all-agent fixture). */
  resolveOwnerName(workspaceId: string): Promise<string | undefined>;
  /** Persist the message (the same repo write the REST `POST /channels/:cid/messages` route uses). */
  post(input: {
    workspaceId: string;
    channelId: string;
    authorMemberId: string;
    body: string;
  }): Promise<{ id: string }>;
}

export class CoordinationChannelBridge {
  constructor(private readonly deps: CoordinationBridgeDeps) {}

  /**
   * Post a coordination event into its department channel, authored as the acting agent. Returns a
   * structured outcome and never throws — every gate/miss/error is reported, so a caller can safely
   * `await bridge.post(...)` inside an audited path without risking the underlying write.
   */
  async post(workspaceId: string, event: CoordinationEvent): Promise<BridgeResult> {
    try {
      if (!isAgentChannelPostingEnabledForWorkspace(this.deps.caps(workspaceId), workspaceId)) {
        return { posted: false, reason: "disabled" };
      }
      // The owner name is only needed for the approval @mention; resolve it just there.
      const ownerName =
        event.kind === "approval_required"
          ? await this.deps.resolveOwnerName(workspaceId)
          : undefined;
      const composed = composePost(event, { ownerName });

      const channelId = await this.deps.resolveChannelId(workspaceId, composed.channel);
      if (!channelId) return { posted: false, reason: "no-channel" };

      const author = await this.deps.resolveAgentMember(workspaceId, composed.authorHandle);
      if (!author) return { posted: false, reason: "no-author" };

      const message = await this.deps.post({
        workspaceId,
        channelId,
        authorMemberId: author.memberId,
        body: composed.body,
      });
      return { posted: true, messageId: message.id, channelId, authorMemberId: author.memberId };
    } catch {
      // Best-effort: the bridge sits on top of audited paths and must never fail the underlying write.
      return { posted: false, reason: "error" };
    }
  }
}
