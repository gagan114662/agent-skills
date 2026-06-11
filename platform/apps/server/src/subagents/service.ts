import type { Capability } from "../auth/access.js";
import { satisfies } from "../auth/access.js";
import type { AgentPersona } from "../db/repositories/personas.js";
import { personaHarnessEnv, resolveToolScope } from "./scope.js";

/**
 * SubagentService — the single security gate for invoking a custom subagent (#59).
 *
 * Invoking a persona launches a real harness session **as the persona's own agent member**, scoped
 * to the persona's allowed-tools ceiling, threaded under the invoking @mention message. The
 * non-escalation guarantee is enforced here by reusing the #9 capability ladder — NOT a new RBAC
 * system:
 *   1. The channel must belong to the caller's workspace (#3 IDOR).
 *   2. Invoking is *delegation*, so the invoker needs `propagate` on the channel.
 *   3. The persona's member must itself hold `write` on the channel (the persona is permitted there).
 *   4. If bound to a message, the persona must actually be @-mentioned on it (mention-driven).
 *   5. The requested tools can only *narrow* the persona ceiling.
 * The session then runs as the persona member, bounded by that member's own grants downstream — so an
 * invocation can never give a persona access it does not already have.
 *
 * All collaborators are injected so the gate is fully unit-testable without a DB or a live harness.
 */

export interface SubagentLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    parentMessageId?: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

export interface SubagentServiceDeps {
  /** Persona by id, workspace-scoped + active-only (#3/#9). */
  getPersona(personaId: string, workspaceId: string): Promise<AgentPersona | undefined>;
  /** The workspace a channel belongs to (or undefined if it does not exist). */
  getChannelWorkspace(channelId: string): Promise<string | undefined>;
  /** A member's effective capability on a channel (#9 ladder), for invoker AND persona. */
  channelCapabilityFor(
    workspaceId: string,
    memberId: string,
    channelId: string,
  ): Promise<Capability | null>;
  /** Member ids @-mentioned on a message (#6), to bind an invocation to its mention. */
  mentionedMemberIds(messageId: string): Promise<string[]>;
  /**
   * The per-agent skill kit a session loads (#155). Resolves a persona to its skill ids (default: none).
   * The marketing wiring binds this to the blueprint (skills by @handle); a generic persona returns [].
   * Skills reach the harness via `AGENT_SKILLS` (env, never argv).
   */
  resolveSkills?: (persona: AgentPersona) => string[];
  launcher: SubagentLauncher;
}

export interface SubagentInvokeInput {
  personaId: string;
  channelId: string;
  task: string;
  /** The invoking @mention message; becomes the thread root for the result. */
  messageId?: string;
  /** Optionally narrow (never widen) the persona's tool ceiling for this run. */
  tools?: string[];
}

export type SubagentInvokeResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: 400 | 403 | 404; error: string };

interface InvokerIdentity {
  workspaceId: string;
  memberId: string;
}

export class SubagentService {
  constructor(private readonly deps: SubagentServiceDeps) {}

  async invoke(
    identity: InvokerIdentity,
    input: SubagentInvokeInput,
  ): Promise<SubagentInvokeResult> {
    // 1. Channel exists + belongs to the caller's workspace (IDOR: a cross-tenant channel is a 404).
    const channelWorkspace = await this.deps.getChannelWorkspace(input.channelId);
    if (!channelWorkspace || channelWorkspace !== identity.workspaceId) {
      return { ok: false, code: 404, error: "channel not found" };
    }

    // 2. Invoking a subagent is delegation — the invoker must hold `propagate` on the channel.
    const invokerCap = await this.deps.channelCapabilityFor(
      identity.workspaceId,
      identity.memberId,
      input.channelId,
    );
    if (!invokerCap || !satisfies(invokerCap, "propagate")) {
      return { ok: false, code: 403, error: "requires propagate capability to invoke a subagent" };
    }

    // 3. The persona must exist in this workspace and be active (#3/#9).
    const persona = await this.deps.getPersona(input.personaId, identity.workspaceId);
    if (!persona) {
      return { ok: false, code: 404, error: "persona not found" };
    }

    // 4. The persona's own member must be permitted in the channel (>= write). The session runs as
    //    this member, so it can never act where the member itself has no grant.
    const personaCap = await this.deps.channelCapabilityFor(
      identity.workspaceId,
      persona.agentMemberId,
      input.channelId,
    );
    if (!personaCap || !satisfies(personaCap, "write")) {
      return { ok: false, code: 403, error: "persona is not permitted in this channel" };
    }

    // 5. If bound to a message, the persona must actually be @-mentioned on it (mention-driven).
    if (input.messageId) {
      const mentioned = await this.deps.mentionedMemberIds(input.messageId);
      if (!mentioned.includes(persona.agentMemberId)) {
        return { ok: false, code: 400, error: "persona is not mentioned on this message" };
      }
    }

    // 6. Resolve the tool scope (narrow-only) and launch the session as the persona member.
    const scope = resolveToolScope(persona.allowedTools, input.tools);
    const session = await this.deps.launcher.launch({
      workspaceId: identity.workspaceId,
      channelId: input.channelId,
      agentMemberId: persona.agentMemberId,
      createdByMemberId: identity.memberId,
      task: input.task,
      parentMessageId: input.messageId,
      harnessEnv: personaHarnessEnv(persona, scope, this.deps.resolveSkills?.(persona) ?? []),
    });
    return { ok: true, sessionId: session.id };
  }
}
