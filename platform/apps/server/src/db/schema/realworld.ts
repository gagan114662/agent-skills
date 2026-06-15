import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Real-world tool surface receipts (#231). One workspace-scoped table, `realworld_artifacts`: the
 * durable "did the fleet actually do real work?" trail. One row per attempted outward artifact —
 * blocked (a required account isn't connected), pending_approval (parked at the #13 gate), published
 * (a live reachable URL), or failed. This is what turns the founder-console "real artifacts" signal
 * from an assertion into evidence.
 *
 * Only `workspace_id` carries the #3 tenant boundary (ON DELETE CASCADE). `venture_id` /
 * `approval_request_id` are SOFT refs (no FK) — the receipt must outlive a pruned venture/approval.
 * The table name is deliberately NOT `venture_`/`growth_`-prefixed so the #155 colocation gate does
 * not class it as a governed metric surface.
 */

export const REALWORLD_TOOLS = [
  "publish",
  "publish_site",
  "send_email",
  "post_social",
  "browse",
  "research",
  "store_asset",
  "call_api",
] as const;

export const REALWORLD_ARTIFACT_STATUSES = [
  "blocked",
  "pending_approval",
  "published",
  "failed",
] as const;

export const realworldArtifacts = pgTable(
  "realworld_artifacts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureId: uuid("venture_id"),
    tool: text("tool", { enum: REALWORLD_TOOLS }).notNull(),
    url: text("url"),
    provider: text("provider").notNull(),
    status: text("status", { enum: REALWORLD_ARTIFACT_STATUSES }).notNull(),
    approvalRequestId: uuid("approval_request_id"),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("realworld_artifacts_workspace_created_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    toolCk: check(
      "realworld_artifacts_tool_ck",
      sql`${t.tool} IN ('publish','publish_site','send_email','post_social','browse','research','store_asset','call_api')`,
    ),
    statusCk: check(
      "realworld_artifacts_status_ck",
      sql`${t.status} IN ('blocked','pending_approval','published','failed')`,
    ),
  }),
);
