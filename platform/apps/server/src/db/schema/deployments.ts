import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { channels } from "./channels.js";
import { agentSessions } from "./agent-sessions.js";
import { members } from "./identities.js";

/**
 * A deployment of a session's app to a live URL (issue #73, ADR-0041).
 *
 * Each deploy is **immutable** — a new row per deploy/redeploy/rollback — so the row history IS the
 * backup set and rollback re-promotes a prior `ready` one. `provider_deployment_id` correlates our row
 * to the provider's immutable deployment. `logs` holds a bounded, **redacted** tail (secrets are
 * scrubbed before they are ever persisted). Workspace/channel-scoped for tenant isolation (#9).
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // dryrun | vercel
    status: text("status").notNull(), // DeployStatus
    url: text("url"),
    providerDeploymentId: text("provider_deployment_id"),
    framework: text("framework"),
    error: text("error"),
    reason: text("reason"), // deploy | push | rollback
    // Soft self-pointer to the deployment a rollback re-promoted (SET NULL on delete via the migration).
    rolledBackFromId: uuid("rolled_back_from_id"),
    logs: jsonb("logs").notNull().default(sql`'[]'::jsonb`),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySession: index("deployments_session_idx").on(t.sessionId),
    byChannel: index("deployments_channel_idx").on(t.channelId),
    byWorkspace: index("deployments_workspace_idx").on(t.workspaceId),
  }),
);
