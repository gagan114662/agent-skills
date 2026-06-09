import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../index.js";
import { agentPersonas, agents } from "../schema/index.js";
import { createAgentWithToken } from "./auth.js";

/**
 * Agent persona / subagent registry (issue #59).
 *
 * Defining a persona mints an agent member (reusing the #3 `createAgentWithToken` path so the persona
 * is @-mentionable + flows through every existing path) and pairs it with a prompt + tool ceiling.
 * Reads are workspace-scoped (#3 IDOR) and skip personas whose underlying agent is deactivated (#9).
 */

export interface AgentPersona {
  id: string;
  workspaceId: string;
  agentMemberId: string;
  agentId: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string | null;
  isBuiltin: boolean;
  createdByMemberId: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: agentPersonas.id,
  workspaceId: agentPersonas.workspaceId,
  agentMemberId: agentPersonas.agentMemberId,
  agentId: agentPersonas.agentId,
  name: agentPersonas.name,
  systemPrompt: agentPersonas.systemPrompt,
  allowedTools: agentPersonas.allowedTools,
  model: agentPersonas.model,
  isBuiltin: agentPersonas.isBuiltin,
  createdByMemberId: agentPersonas.createdByMemberId,
  createdAt: agentPersonas.createdAt,
} as const;

function hydrate(row: Record<string, unknown>): AgentPersona {
  return { ...(row as unknown as AgentPersona), allowedTools: (row.allowedTools as string[]) ?? [] };
}

/**
 * Define a persona: create its agent member + token (reusing #3), then insert the persona row. The
 * raw token is returned ONCE (the caller surfaces it; only its hash is stored).
 */
export async function definePersona(
  input: {
    workspaceId: string;
    name: string;
    systemPrompt: string;
    allowedTools: string[];
    model: string | null;
    isBuiltin?: boolean;
    tokenHash: string;
  },
  createdByMemberId: string,
): Promise<AgentPersona> {
  const { agentId, memberId } = await createAgentWithToken({
    workspaceId: input.workspaceId,
    name: input.name,
    framework: "persona",
    tokenHash: input.tokenHash,
  });
  const [row] = await db
    .insert(agentPersonas)
    .values({
      workspaceId: input.workspaceId,
      agentMemberId: memberId,
      agentId,
      name: input.name,
      systemPrompt: input.systemPrompt,
      allowedTools: input.allowedTools,
      model: input.model,
      isBuiltin: input.isBuiltin ?? false,
      createdByMemberId,
    })
    .returning(COLUMNS);
  return hydrate(row as Record<string, unknown>);
}

/** A persona by id, workspace-scoped (#3 IDOR) and only while its agent is active (#9). */
export async function getPersona(
  personaId: string,
  workspaceId: string,
): Promise<AgentPersona | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(agentPersonas)
    .innerJoin(agents, eq(agents.id, agentPersonas.agentId))
    .where(
      and(
        eq(agentPersonas.id, personaId),
        eq(agentPersonas.workspaceId, workspaceId),
        isNull(agents.deactivatedAt),
      ),
    )
    .limit(1);
  return row ? hydrate(row as Record<string, unknown>) : undefined;
}

/** A persona by its @handle (case-insensitive), workspace-scoped and active-only. */
export async function getPersonaByHandle(
  workspaceId: string,
  handle: string,
): Promise<AgentPersona | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(agentPersonas)
    .innerJoin(agents, eq(agents.id, agentPersonas.agentId))
    .where(
      and(
        eq(agentPersonas.workspaceId, workspaceId),
        sql`lower(${agentPersonas.name}) = lower(${handle})`,
        isNull(agents.deactivatedAt),
      ),
    )
    .limit(1);
  return row ? hydrate(row as Record<string, unknown>) : undefined;
}

/** The persona owning a given agent member (used to map a mentioned member back to its persona). */
export async function getPersonaByAgentMember(
  workspaceId: string,
  agentMemberId: string,
): Promise<AgentPersona | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(agentPersonas)
    .innerJoin(agents, eq(agents.id, agentPersonas.agentId))
    .where(
      and(
        eq(agentPersonas.workspaceId, workspaceId),
        eq(agentPersonas.agentMemberId, agentMemberId),
        isNull(agents.deactivatedAt),
      ),
    )
    .limit(1);
  return row ? hydrate(row as Record<string, unknown>) : undefined;
}

/** The active persona roster for a workspace. */
export async function listPersonas(workspaceId: string): Promise<AgentPersona[]> {
  const rows = await db
    .select(COLUMNS)
    .from(agentPersonas)
    .innerJoin(agents, eq(agents.id, agentPersonas.agentId))
    .where(and(eq(agentPersonas.workspaceId, workspaceId), isNull(agents.deactivatedAt)));
  return rows.map((r) => hydrate(r as Record<string, unknown>));
}

/** Member display names that are personas (for #6 mention → persona resolution). */
export async function isPersonaMember(
  workspaceId: string,
  agentMemberId: string,
): Promise<boolean> {
  return (await getPersonaByAgentMember(workspaceId, agentMemberId)) !== undefined;
}
