import { generateAgentToken } from "../auth/secrets.js";
import {
  definePersona,
  getPersonaByHandle,
  type AgentPersona,
} from "../db/repositories/personas.js";
import { validatePersonaInput } from "./scope.js";

/**
 * Built-in reference subagents (#59). `code-reviewer` is the canonical persona: a code-review prompt
 * with a read-mostly tool ceiling. Built-ins are ordinary personas (no special authority) — they are
 * seeded so a workspace has a working `@code-reviewer` out of the box.
 */
export const BUILTIN_PERSONAS = [
  {
    name: "code-reviewer",
    systemPrompt:
      "You are a senior code reviewer. Review the diff or files referenced in the task for " +
      "correctness, security, and clarity. Be specific: cite file and line, explain the risk, and " +
      "suggest the concrete fix. Prefer a short, high-signal list over exhaustive nitpicks. You may " +
      "read and search the codebase but do not modify files.",
    allowedTools: ["Read", "Grep", "Glob", "Bash"],
    model: null as string | null,
  },
] as const;

/**
 * Seed the built-in personas for a workspace, idempotently: a persona whose handle already exists is
 * left untouched (so re-seeding never duplicates or rotates tokens). Returns the personas that exist
 * after seeding (created or pre-existing).
 */
export async function seedBuiltinPersonas(
  workspaceId: string,
  createdByMemberId: string,
): Promise<AgentPersona[]> {
  const out: AgentPersona[] = [];
  for (const def of BUILTIN_PERSONAS) {
    const existing = await getPersonaByHandle(workspaceId, def.name);
    if (existing) {
      out.push(existing);
      continue;
    }
    const v = validatePersonaInput({ ...def, allowedTools: [...def.allowedTools] });
    const { hash } = generateAgentToken();
    out.push(
      await definePersona(
        {
          workspaceId,
          name: v.name,
          systemPrompt: v.systemPrompt,
          allowedTools: v.allowedTools,
          model: v.model,
          isBuiltin: true,
          tokenHash: hash,
        },
        createdByMemberId,
      ),
    );
  }
  return out;
}
