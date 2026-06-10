import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * SRE Loop persistence (#112, ADR-0112). One workspace-scoped table — the durable incident. It makes
 * an SLO breach a tracked thing with a lifecycle (`firing` → `escalated` → `resolved`) instead of a
 * log line: the breached service + SLO kind, severity, observed/target/budget, the triage session that
 * was launched, and the drafted postmortem path all persist, so an incident leaves a trace.
 *
 * The triage-session column is a **soft reference** (no FK): a session row is audit history that may be
 * pruned independently, and the incident must outlive it. Only `workspace_id` carries the #3 tenant
 * boundary (`onDelete: cascade`). A **partial unique index** (in the migration) guarantees one open
 * incident per `(workspace_id, service, slo_kind)` so a sustained breach never floods the queue.
 */

export const SRE_INCIDENT_STATUSES = ["firing", "escalated", "resolved"] as const;
export const SRE_SLO_KINDS = ["availability", "latency_p95", "queue_lag"] as const;
export const SRE_SEVERITIES = ["warning", "critical"] as const;

export const sreIncidents = pgTable(
  "sre_incidents",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The service whose SLO breached (e.g. "api", "db", "redis"). */
    service: text("service").notNull(),
    sloKind: text("slo_kind", { enum: SRE_SLO_KINDS }).notNull(),
    severity: text("severity", { enum: SRE_SEVERITIES }).notNull().default("warning"),
    status: text("status", { enum: SRE_INCIDENT_STATUSES }).notNull().default("firing"),
    /** The observed value that breached, in the SLO's natural unit. */
    observedValue: doublePrecision("observed_value").notNull(),
    targetValue: doublePrecision("target_value").notNull(),
    /** Error budget remaining at open (0..1). */
    budgetRemaining: doublePrecision("budget_remaining").notNull(),
    /** The triage session launched for this incident (soft ref, null until launched). */
    triageSessionId: uuid("triage_session_id"),
    /** The drafted postmortem path under docs/postmortems/ (null until resolved + drafted). */
    postmortemPath: text("postmortem_path"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last page/notification time — the re-page cooldown reference. */
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceStatus: index("sre_incidents_workspace_status_idx").on(t.workspaceId, t.status),
    byService: index("sre_incidents_service_idx").on(t.workspaceId, t.service, t.sloKind),
    statusCk: check(
      "sre_incidents_status_ck",
      sql`${t.status} IN ('firing','escalated','resolved')`,
    ),
    sloKindCk: check(
      "sre_incidents_slo_kind_ck",
      sql`${t.sloKind} IN ('availability','latency_p95','queue_lag')`,
    ),
    severityCk: check("sre_incidents_severity_ck", sql`${t.severity} IN ('warning','critical')`),
  }),
);
