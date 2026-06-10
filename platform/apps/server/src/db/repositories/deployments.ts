import { and, desc, eq } from "drizzle-orm";
import type { DeployStatus } from "@reload/shared";
import { db } from "../index.js";
import { deployments } from "../schema/index.js";
import type { DeploymentStore } from "../../deploy/manager.js";

export type { DeployStatus } from "@reload/shared";

/** A deployment row (#73). `logs` is a bounded, redacted tail. */
export interface Deployment {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string;
  provider: string;
  status: DeployStatus;
  url: string | null;
  providerDeploymentId: string | null;
  framework: string | null;
  error: string | null;
  reason: string | null;
  rolledBackFromId: string | null;
  logs: string[];
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields set when a deployment row is first created (status starts `building`). */
export interface CreateDeploymentInput {
  workspaceId: string;
  channelId: string;
  sessionId: string;
  provider: string;
  status: DeployStatus;
  framework?: string | null;
  reason?: string | null;
  rolledBackFromId?: string | null;
  createdByMemberId?: string | null;
}

/** Fields a deploy updates as it progresses (terminal status + url + redacted logs). */
export interface UpdateDeploymentFields {
  status?: DeployStatus;
  url?: string | null;
  providerDeploymentId?: string | null;
  error?: string | null;
  rolledBackFromId?: string | null;
  logs?: string[];
}

const COLUMNS = {
  id: deployments.id,
  workspaceId: deployments.workspaceId,
  channelId: deployments.channelId,
  sessionId: deployments.sessionId,
  provider: deployments.provider,
  status: deployments.status,
  url: deployments.url,
  providerDeploymentId: deployments.providerDeploymentId,
  framework: deployments.framework,
  error: deployments.error,
  reason: deployments.reason,
  rolledBackFromId: deployments.rolledBackFromId,
  logs: deployments.logs,
  createdByMemberId: deployments.createdByMemberId,
  createdAt: deployments.createdAt,
  updatedAt: deployments.updatedAt,
} as const;

/**
 * Repository-backed deployment store implementing the injectable {@link DeploymentStore} seam, so the
 * DeployManager persists durably in production while unit tests inject an in-memory store. Reads are
 * **channel-scoped** to enforce tenant isolation (#9, IDOR-safe), exactly like `getAgentSession`.
 */
export const dbDeploymentStore: DeploymentStore = {
  async create(input: CreateDeploymentInput): Promise<Deployment> {
    const [row] = await db
      .insert(deployments)
      .values({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        sessionId: input.sessionId,
        provider: input.provider,
        status: input.status,
        framework: input.framework ?? null,
        reason: input.reason ?? null,
        rolledBackFromId: input.rolledBackFromId ?? null,
        createdByMemberId: input.createdByMemberId ?? null,
      })
      .returning(COLUMNS);
    return row as Deployment;
  },

  async update(id: string, fields: UpdateDeploymentFields): Promise<Deployment> {
    const [row] = await db
      .update(deployments)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(deployments.id, id))
      .returning(COLUMNS);
    return row as Deployment;
  },

  async get(id: string, channelId: string): Promise<Deployment | undefined> {
    const [row] = await db
      .select(COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.id, id), eq(deployments.channelId, channelId)))
      .limit(1);
    return row as Deployment | undefined;
  },

  async latestForSession(sessionId: string, channelId: string): Promise<Deployment | undefined> {
    const [row] = await db
      .select(COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.sessionId, sessionId), eq(deployments.channelId, channelId)))
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    return row as Deployment | undefined;
  },

  async listForSession(sessionId: string, channelId: string): Promise<Deployment[]> {
    const rows = await db
      .select(COLUMNS)
      .from(deployments)
      .where(and(eq(deployments.sessionId, sessionId), eq(deployments.channelId, channelId)))
      .orderBy(desc(deployments.createdAt));
    return rows as Deployment[];
  },
};
