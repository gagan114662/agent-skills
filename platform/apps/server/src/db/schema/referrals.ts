import { pgTable, uuid, text, timestamp, integer, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

export const referralCodes = pgTable(
  "referral_codes",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerMemberId: uuid("owner_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    code: text("code").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: uniqueIndex("referral_codes_workspace_uq").on(t.workspaceId),
  }),
);

export const referralSignups = pgTable(
  "referral_signups",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    referralCodeId: uuid("referral_code_id")
      .notNull()
      .references(() => referralCodes.id, { onDelete: "cascade" }),
    referrerWorkspaceId: uuid("referrer_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    referredWorkspaceId: uuid("referred_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    referredMemberId: uuid("referred_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    trackingRef: text("tracking_ref"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byReferrer: index("referral_signups_referrer_idx").on(t.referrerWorkspaceId, t.occurredAt),
    byReferred: uniqueIndex("referral_signups_referred_uq").on(t.referredWorkspaceId),
  }),
);

export const referralIncentives = pgTable(
  "referral_incentives",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    referralSignupId: uuid("referral_signup_id")
      .notNull()
      .references(() => referralSignups.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    byWorkspace: index("referral_incentives_workspace_idx").on(t.workspaceId, t.createdAt),
    dedupe: unique("referral_incentives_signup_workspace_kind_uq").on(t.referralSignupId, t.workspaceId, t.kind),
  }),
);
