/**
 * Room-brief launch (GAP-1, path C) — pure policy + subtask builder, no IO.
 *
 * THE BUG: a brief posted as a RAW channel message to the room's `general` channel — not via the
 * `/everyday` composer, and without an `@mention` — no-ops at the #123 mention trigger (no addressed
 * persona ⇒ nothing launches). So the owner's brief is never threaded into any subtask; the only content
 * the room ever shows is the ambient owner-venture ("acquire paying founders for ipop.ai"). Ten different
 * briefs all read back as generic "market ipop" self-promo because none of them ever became a task.
 *
 * THE FIX (this module): make the room's general channel behave like the external messaging bridge
 * (`inbound-team-launch.ts`) — a human brief starts ONE threaded team-run whose subtasks carry the OWNER'S
 * brief text verbatim, built with the SAME {@link buildSubtask} graph the Telegram/iMessage path uses, so
 * the run can never fall back to a generic default. The IO seam (`marketing/default.ts`) resolves the
 * seeded agents + coordinator and calls {@link handleRoomBriefPost}; this file is the pure, unit-testable
 * core (policy + builder + the dependency-injected handler), mirroring `mention-trigger.ts`.
 *
 * Gating: owner-workspace-first + DEFAULT-OFF (`shouldLaunchRoomBriefForWorkspace`), reusing the existing
 * `marketing.ownerWorkspaceId` marker — so an unconfigured deployment (and the `/everyday` composer, which
 * posts to `general` AND launches its own run) is byte-for-byte unchanged, and the auto-launch only comes
 * alive on the owner's own workspace where the raw-brief surface is dogfooded first.
 *
 * #200: the brief is OWNER-typed and is carried as the task objective only — never interpreted as an
 * instruction that could widen scope. Nothing here sends, spends, or grants a tool; every irreversible
 * action still passes the existing #13 approval gates once the launched agents produce drafts.
 */

import { buildSubtask, LAUNCH_HANDLES } from "../messaging/inbound-team-launch.js";
import type { RuntimeProvider } from "../runtime/provider.js";
import type { Subtask } from "../team/coordinator.js";

/** The single shared room channel a fresh workspace briefs its team in (matches `ROOM_CHANNEL_NAME`). */
export const ROOM_BRIEF_CHANNEL = "general" as const;

/** Minimum non-whitespace length for a message to read as a brief (a bare "hi" is chat, not a brief). */
export const MIN_ROOM_BRIEF_CHARS = 8;

/** True iff this is the room's briefing channel (department channels use the #123 @mention path instead). */
export function isRoomBriefChannel(name: string | null): boolean {
  return name === ROOM_BRIEF_CHANNEL;
}

/** A seeded department agent the room-brief run can target (the launch handle + its agent member id). */
export interface RoomBriefAgent {
  handle: (typeof LAUNCH_HANDLES)[number];
  agentMemberId: string;
}

/**
 * Build the Scout → Quill → Lens → Echo/Bid subtask graph for a room brief, threading the OWNER'S brief
 * text into every lane via the SAME {@link buildSubtask} the messaging bridge uses. A handle with no
 * seeded agent is skipped (never invented). The objective is passed as data — never a canned default.
 */
export function buildRoomBriefSubtasks(
  objective: string,
  agents: readonly RoomBriefAgent[],
  provider: RuntimeProvider,
): Subtask[] {
  const byHandle = new Map(agents.map((agent) => [agent.handle, agent.agentMemberId]));
  return LAUNCH_HANDLES.flatMap((handle) => {
    const agentMemberId = byHandle.get(handle);
    return agentMemberId ? [buildSubtask(handle, agentMemberId, objective, provider)] : [];
  });
}

/**
 * Owner-workspace-first + DEFAULT-OFF gate. Active only when `launchRoomBrief` is set AND this is the named
 * owner workspace — so it dogfoods on ipop's own workspace before any tenant, and an unconfigured
 * deployment never auto-launches a run from a plain channel message. Mirrors `shouldInjectWorkspaceContext`.
 */
export function shouldLaunchRoomBriefForWorkspace(
  marketing: { launchRoomBrief?: boolean; ownerWorkspaceId?: string },
  workspaceId: string,
): boolean {
  if (!marketing.launchRoomBrief) return false;
  return marketing.ownerWorkspaceId !== undefined && marketing.ownerWorkspaceId === workspaceId;
}

/** The pure decision: should this just-posted message start a room-brief team-run? */
export function shouldLaunchRoomBrief(input: {
  authorKind: "human" | "agent";
  isRoomChannel: boolean;
  addressedPersonaCount: number;
  body: string;
}): boolean {
  // Human authors only — an agent post must never auto-launch another run (no agent↔agent loops).
  if (input.authorKind !== "human") return false;
  // Only the room's briefing channel; department channels are the #123 @mention path's surface.
  if (!input.isRoomChannel) return false;
  // An @mention is already handled by the mention trigger — don't double-launch the same message.
  if (input.addressedPersonaCount > 0) return false;
  // A non-trivial brief, not a one-word chat line.
  const trimmed = input.body.trim();
  if (trimmed.length < MIN_ROOM_BRIEF_CHARS) return false;
  return /[a-z0-9]/i.test(trimmed);
}

/** The IO seam a room-brief launch needs: address resolution and the actual (gated) launch. */
export interface RoomBriefTriggerDeps {
  /** True iff `name` is the room's briefing channel. */
  isRoomChannel(name: string | null): boolean;
  /** How many department personas this message @mentions (already persisted by the fan-out). */
  addressedPersonaCount(workspaceId: string, messageId: string): Promise<number>;
  /** Launch the threaded room-brief team-run on the given objective (gated, best-effort). */
  launchRoomBrief(input: { channelId: string; messageId: string; objective: string }): Promise<void>;
}

/**
 * Handle a freshly-posted room message for the room-brief trigger. Pure branching over injected deps
 * (mirrors `handleHumanMentionPost`): resolves how many personas were addressed, applies
 * {@link shouldLaunchRoomBrief}, and — only for a qualifying human brief — launches ONE threaded run on
 * the message body. Best-effort: all effects are through the deps; a launch failure is the caller's to log.
 */
export async function handleRoomBriefPost(
  deps: RoomBriefTriggerDeps,
  identity: { workspaceId: string; memberId: string; kind: "human" | "agent" },
  channel: { id: string; name: string | null },
  message: { id: string; body: string },
): Promise<void> {
  const addressedPersonaCount = await deps.addressedPersonaCount(identity.workspaceId, message.id);
  const launch = shouldLaunchRoomBrief({
    authorKind: identity.kind,
    isRoomChannel: deps.isRoomChannel(channel.name),
    addressedPersonaCount,
    body: message.body,
  });
  if (!launch) return;
  await deps.launchRoomBrief({
    channelId: channel.id,
    messageId: message.id,
    objective: message.body,
  });
}
