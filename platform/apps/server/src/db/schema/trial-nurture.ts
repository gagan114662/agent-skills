import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { members } from "./identities.js";
import { workspaces } from "./workspaces.js";

export const trialNurtureProfiles = pgTable(
  "trial_nurture_profiles",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    variantKey: text("variant_key").notNull(),
    firstValueAt: timestamp("first_value_at", { withTimezone: true }),
    upgradeClickedAt: timestamp("upgrade_clicked_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    providerEventId: text("provider_event_id"),
    revenueCents: integer("revenue_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("trial_nurture_profiles_workspace_idx").on(t.workspaceId, t.variantKey),
    memberUq: unique("trial_nurture_profiles_member_uq").on(t.workspaceId, t.memberId),
    variantCk: check("trial_nurture_profiles_variant_ck", sql`${t.variantKey} IN ('aha_first','upgrade_moment')`),
    revenueCk: check("trial_nurture_profiles_revenue_ck", sql`${t.revenueCents} >= 0`),
  }),
);

export const trialNurtureEvents = pgTable(
  "trial_nurture_events",
  {
    id: uuid("id").primaryKey(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => trialNurtureProfiles.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byProfile: index("trial_nurture_events_profile_idx").on(t.profileId, t.kind),
    kindCk: check(
      "trial_nurture_events_kind_ck",
      sql`${t.kind} IN ('nudge_view','email_draft','first_value','upgrade_click','paid')`,
    ),
  }),
);
