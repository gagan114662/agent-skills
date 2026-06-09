import { listMentionsOnMessage } from "../db/repositories/mentions.js";
import { getPersonaByAgentMember, type AgentPersona } from "../db/repositories/personas.js";

/**
 * Resolve the subagent personas @-mentioned on a message (#59, reusing #6 mentions).
 *
 * `listMentionsOnMessage` already maps `@handle` tokens to members; this keeps only the agent members
 * that are personas in the caller's workspace, preserving mention order. This is the seam that turns
 * `@code-reviewer review this diff` into an invocable subagent.
 */
export async function personaMentionsOnMessage(
  workspaceId: string,
  messageId: string,
): Promise<AgentPersona[]> {
  const mentions = await listMentionsOnMessage(messageId);
  const personas: AgentPersona[] = [];
  for (const m of mentions) {
    if (m.kind !== "agent") continue;
    const persona = await getPersonaByAgentMember(workspaceId, m.memberId);
    if (persona) personas.push(persona);
  }
  return personas;
}
