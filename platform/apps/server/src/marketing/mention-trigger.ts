/**
 * The post-time @mention trigger logic (#123 launch + #468 no-silent-drops), as a PURE, dependency-injected
 * function so the branching is unit-testable without a DB or a live harness.
 *
 * #468 (P0): a triggered run must NEVER vanish. Before this, an `@scout` (or #471 natural address) posted in a
 * channel that isn't one of the eight department channels returned silently — no session, no message, no error
 * — and a launch DENIAL (RBAC) was swallowed by the best-effort caller. Both read to the user as "the fleet
 * ignored me." This handler converts every such dead end into a visible in-channel notice posted AS the
 * addressed agent, so the acceptance holds: every addressed run yields a message, a visible error, or a notice.
 *
 * It does NOT broaden the launch surface: a real session still launches only in a department channel (the
 * agent's home, where its context + tooling belong). Off its home channel the agent simply says where to
 * reach it — honest, and not a silent drop.
 */
import type { MarketingMentionResult } from "./mention.js";

/** An addressed department teammate resolved from the just-posted message's persisted mentions. */
export interface AddressedPersona {
  /** The persona's agent member id (the author of any notice we post back). */
  agentMemberId: string;
  /** The @-handle / display name addressed (e.g. "scout"). */
  name: string;
  /** The agent's home department channel name (where a real launch happens), e.g. "seo". */
  homeChannel: string;
}

export interface MentionTriggerDeps {
  /** True iff `name` is one of the department channels where a real launch may run. */
  isMarketingChannel(name: string | null): boolean;
  /** Launch the addressed personas (the audited #59 path). Only called for a marketing channel. */
  launch(input: { channelId: string; messageId: string; task: string }): Promise<MarketingMentionResult>;
  /** Department teammates addressed on this message (resolved from already-persisted mention rows). */
  addressedDepartmentPersonas(workspaceId: string, messageId: string): Promise<AddressedPersona[]>;
  /** Post an in-channel notice AS the agent. Best-effort: a failure here must not throw past the caller. */
  postNotice(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    body: string;
    parentMessageId: string;
  }): Promise<void>;
}

/** The notice an agent posts when addressed OUTSIDE its home channel — honest redirect, never a silent drop. */
export function offChannelNotice(personaName: string, homeChannel: string): string {
  const name = personaName.charAt(0).toUpperCase() + personaName.slice(1);
  return (
    `👋 ${name} here — I pick up work from my channel, #${homeChannel}. ` +
    `@mention me there (or ask me there in plain words) and I'll get right on it.`
  );
}

/** The notice an agent posts when a launch in its home channel was DENIED — surfaced, not swallowed. */
export function launchDeniedNotice(personaName: string, reason: string): string {
  const name = personaName.charAt(0).toUpperCase() + personaName.slice(1);
  const why = reason.trim() ? reason.trim() : "the fleet is at capacity right now";
  return `⚠️ ${name} couldn't start that run — ${why}. Give it another go in a moment.`;
}

/**
 * Handle a freshly-posted message for the marketing @mention trigger. Human authors only (the caller guards
 * `identity.kind`). Returns nothing; all effects are through the injected deps and are best-effort.
 */
export async function handleHumanMentionPost(
  deps: MentionTriggerDeps,
  identity: { workspaceId: string; memberId: string },
  channel: { id: string; name: string | null },
  message: { id: string; body: string },
): Promise<void> {
  // Resolve who was addressed up front (cheap: reads the mention rows the fan-out already persisted). Used
  // both to launch and — if anything goes wrong — to know which agent should speak the notice back.
  const personas = await deps.addressedDepartmentPersonas(identity.workspaceId, message.id);

  if (deps.isMarketingChannel(channel.name)) {
    const result = await deps.launch({ channelId: channel.id, messageId: message.id, task: message.body });
    // #468: a denial used to be swallowed. Surface it in-channel as the first addressed agent so the user sees
    // why nothing ran instead of a stuck "running" with no output.
    if (!result.ok && personas[0]) {
      await deps.postNotice({
        workspaceId: identity.workspaceId,
        channelId: channel.id,
        agentMemberId: personas[0].agentMemberId,
        body: launchDeniedNotice(personas[0].name, result.error),
        parentMessageId: message.id,
      });
    }
    return;
  }

  // #468: NOT a department channel. A real launch belongs in the agent's home channel, but a silent drop is the
  // bug — so if a department agent was addressed here, it says where to reach it. No addressed agent ⇒ genuine
  // no-op (a human-to-human message), exactly as before.
  const addressed = personas[0];
  if (!addressed) return;
  await deps.postNotice({
    workspaceId: identity.workspaceId,
    channelId: channel.id,
    agentMemberId: addressed.agentMemberId,
    body: offChannelNotice(addressed.name, addressed.homeChannel),
    parentMessageId: message.id,
  });
}
