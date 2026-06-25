import { and, eq, gte, isNull, lt, notInArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentDecisions, agentSessions, agents, members, realworldArtifacts, tasks } from "../db/schema/index.js";
import {
  RepositoryDailyActivitySource,
  type DigestAgentRef,
  type DigestArtifactRow,
  type DigestDecisionRow,
  type DigestSessionRow,
  type DigestTaskRow,
} from "./source.js";

/**
 * DB adapter for #589's daily standup source. Kept out of the barrel so pure imports of
 * `standup-digest/index.ts` still avoid initializing the shared Postgres pool.
 */
export function createDbDailyActivitySource(): RepositoryDailyActivitySource {
  return new RepositoryDailyActivitySource({
    async listAgents(workspaceId: string): Promise<DigestAgentRef[]> {
      const rows = await db
        .select({
          id: members.id,
          name: members.displayName,
          role: agents.framework,
        })
        .from(members)
        .leftJoin(agents, eq(agents.id, members.agentId))
        .where(
          and(
            eq(members.workspaceId, workspaceId),
            eq(members.kind, "agent"),
            or(isNull(agents.deactivatedAt), isNull(members.agentId)),
          ),
        );
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
    },

    async listSessions(workspaceId: string, from: Date, to: Date): Promise<DigestSessionRow[]> {
      const rows = await db
        .select({
          id: agentSessions.id,
          agentMemberId: agentSessions.agentMemberId,
          agentName: members.displayName,
          command: agentSessions.command,
          status: agentSessions.status,
          result: agentSessions.result,
          branch: agentSessions.branch,
          headSha: agentSessions.headSha,
          createdAt: agentSessions.createdAt,
          endedAt: agentSessions.endedAt,
        })
        .from(agentSessions)
        .leftJoin(members, eq(members.id, agentSessions.agentMemberId))
        .where(
          and(
            eq(agentSessions.workspaceId, workspaceId),
            lt(agentSessions.createdAt, to),
            or(gte(agentSessions.endedAt, from), isNull(agentSessions.endedAt)),
          ),
        );
      return rows as DigestSessionRow[];
    },

    async listDecisions(workspaceId: string, from: Date, to: Date): Promise<DigestDecisionRow[]> {
      const rows = await db
        .select({
          id: agentDecisions.id,
          decidedByMemberId: agentDecisions.decidedByMemberId,
          title: agentDecisions.title,
          rationale: agentDecisions.rationale,
          createdAt: agentDecisions.createdAt,
        })
        .from(agentDecisions)
        .where(
          and(
            eq(agentDecisions.workspaceId, workspaceId),
            eq(agentDecisions.status, "recorded"),
            isNull(agentDecisions.supersededByDecisionId),
            gte(agentDecisions.createdAt, from),
            lt(agentDecisions.createdAt, to),
          ),
        );
      return rows as DigestDecisionRow[];
    },

    async listArtifacts(workspaceId: string, from: Date, to: Date): Promise<DigestArtifactRow[]> {
      const rows = await db
        .select({
          id: realworldArtifacts.id,
          tool: realworldArtifacts.tool,
          provider: realworldArtifacts.provider,
          status: realworldArtifacts.status,
          url: realworldArtifacts.url,
          detail: realworldArtifacts.detail,
          createdAt: realworldArtifacts.createdAt,
        })
        .from(realworldArtifacts)
        .where(
          and(
            eq(realworldArtifacts.workspaceId, workspaceId),
            gte(realworldArtifacts.createdAt, from),
            lt(realworldArtifacts.createdAt, to),
          ),
        );
      return rows as DigestArtifactRow[];
    },

    async listOpenTasks(workspaceId: string): Promise<DigestTaskRow[]> {
      const rows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          assigneeMemberId: tasks.assigneeMemberId,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), notInArray(tasks.status, ["done", "canceled"])));
      return rows as DigestTaskRow[];
    },
  });
}
