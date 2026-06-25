import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import {
  INFRA_PROVIDER_KINDS,
  DEPLOY_TARGET_STATUSES,
  RELEASE_STATUSES,
} from "../../venture-deploy/types.js";

/**
 * Venture Deploys (#195, ADR-0195) — the fleet ships venture products to production itself. Two additive
 * tables, no authority over any existing business-domain table. Deliberately NOT prefixed `venture_` so
 * the colocation governance check (`GOVERNED_TABLE_RE`) does not class them as metric surfaces — they
 * are infra receipts, not scorers (the #192/#194 `external_*`/`finance_*` precedent). Tenant boundary
 * throughout: `workspace_id` (#3 IDOR discipline); `venture_id` is a soft ref (no FK) so a receipt
 * outlives a pruned venture (durable audit trail).
 */

/**
 * The per-venture deploy TARGET (the Fly app / Vercel project + its preview & prod URLs). Provisioned
 * once at venture bootstrap; `unique(workspace_id, venture_id)` makes re-provisioning idempotent.
 * `project_id` is the tenant boundary at the infra layer — a release for one venture can only ever
 * resolve its own target, so there is no cross-venture infra access (AC5). `secret_service_key` points
 * at the venture's write-only vault entry (#192), never the secret values themselves.
 */
export const deployTargets = pgTable(
  "deploy_targets",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureId: uuid("venture_id").notNull(),
    provider: text("provider", { enum: INFRA_PROVIDER_KINDS }).notNull(),
    projectId: text("project_id").notNull(),
    previewUrl: text("preview_url").notNull(),
    prodUrl: text("prod_url").notNull(),
    status: text("status", { enum: DEPLOY_TARGET_STATUSES }).notNull(),
    secretServiceKey: text("secret_service_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byVenture: unique("deploy_targets_venture_uk").on(t.workspaceId, t.ventureId),
    byWorkspace: index("deploy_targets_workspace_idx").on(t.workspaceId, t.createdAt),
    providerCk: check(
      "deploy_targets_provider_ck",
      sql`${t.provider} IN ('dryrun','fly','vercel')`,
    ),
    statusCk: check("deploy_targets_status_ck", sql`${t.status} IN ('provisioned','failed')`),
  }),
);

/**
 * An immutable release receipt — one row per release attempt (deploy → smoke → promote/rollback). This
 * IS the audit trail (#195 AC4) the daily brief reads. `smoke_critical_count = -1` encodes "smoke did
 * not run" (production-grounded: an absent smoke is never a pass, #200 §3). `approval_request_id` is a
 * soft ref to the #13 decision when a prod cutover was gated.
 */
export const deployReleases = pgTable(
  "deploy_releases",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureId: uuid("venture_id").notNull(),
    targetId: uuid("target_id").notNull(),
    releaseRef: text("release_ref").notNull(),
    status: text("status", { enum: RELEASE_STATUSES }).notNull(),
    action: text("action").notNull(), // promote | rollback | escalate
    reversibility: text("reversibility").notNull(), // reversible | cheap | irreversible
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalRequestId: uuid("approval_request_id"),
    smokeCriticalCount: integer("smoke_critical_count").notNull().default(-1),
    promoteHealthOk: boolean("promote_health_ok"),
    promoteHealthDetail: text("promote_health_detail"),
    url: text("url"),
    incidentFiled: boolean("incident_filed").notNull().default(false),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byVenture: index("deploy_releases_venture_idx").on(t.ventureId, t.createdAt),
    byWorkspace: index("deploy_releases_workspace_idx").on(t.workspaceId, t.createdAt),
    statusCk: check(
      "deploy_releases_status_ck",
      sql`${t.status} IN ('deploy_failed','smoke_failed','rolled_back','promoted','escalated')`,
    ),
  }),
);
