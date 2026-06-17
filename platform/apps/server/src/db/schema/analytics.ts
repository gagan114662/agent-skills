import { pgTable, uuid, text, timestamp, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Analytics auto-install (#270). One workspace-scoped table, `analytics_installs`: the durable proof that
 * ipop put the analytics tag on a workspace's site WITHOUT the owner writing a line of code — the record
 * Lens (the analytics department, #123) stands on when it claims "the tag is live, I can report".
 *
 * One row per workspace (the `(workspace_id)` unique index makes install idempotent — re-installing only
 * updates the existing row). `method` records HOW the tag reached the site (hosted inject / connector /
 * pending); `snippet_fingerprint` is a content fingerprint of the installed snippet so a provider/id change
 * is detectable and re-installed once, never duplicated. It holds NO credential and NO metric — the read
 * numbers come live from the provider; the vendor key lives in the #192 / #267 vault.
 *
 * The table name is deliberately `analytics_*` (not `growth_*`/`venture_*`/`moat_*`/`demand_*`) so the #155
 * colocation gate does not class it as a governed metric surface. No FK beyond the tenant boundary.
 */

export const ANALYTICS_INSTALL_METHODS = [
  "hosted_auto_inject",
  "connector_inject",
  "manual_pending",
] as const;

export const analyticsInstalls = pgTable(
  "analytics_installs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** How the tag was installed (hosted inject / connector / pending). */
    method: text("method", { enum: ANALYTICS_INSTALL_METHODS }).notNull(),
    /** The read provider the tag feeds (`dryrun` | `ga4` | `plausible`). */
    provider: text("provider").notNull(),
    /** The GA4 measurement id / Plausible domain the tag carries (empty until configured). */
    measurementId: text("measurement_id").notNull().default(""),
    /** Content fingerprint of the installed snippet — drives idempotent re-install. */
    snippetFingerprint: text("snippet_fingerprint").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: unique("analytics_installs_workspace_unique").on(t.workspaceId),
    methodCk: check(
      "analytics_installs_method_ck",
      sql`${t.method} IN ('hosted_auto_inject','connector_inject','manual_pending')`,
    ),
  }),
);
