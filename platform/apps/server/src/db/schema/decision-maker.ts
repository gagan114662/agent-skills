import { pgTable, uuid, text, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Decision-maker resolver persistence (#223, ADR-0223). ONE workspace-scoped table, `buyer_briefs` — the
 * only thing this loop persists (#200: nothing beyond the brief). One row per produced buyer brief: the
 * resolved buyer (name + public title + role), the falsifiable rationale, the bounded "cares about" tags,
 * and the angle hooks (each carrying its cited public source URL + the quoted, sanitized evidence).
 *
 * Minimal personal data by design: a public name, a public title, a role — NO email / phone / address.
 * `account_id` / `idea_id` are **soft references** (no FK) to the #222 account + #96 venture idea, which
 * may be pruned independently; only `workspace_id` carries the #3 tenant boundary (`onDelete: cascade`).
 */

export const BUYER_ROLES = ["champion", "economic_buyer", "agency", "marketing", "other"] as const;

export const buyerBriefs = pgTable(
  "buyer_briefs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The venture idea (#96) this brief belongs to (soft reference), or null. */
    ideaId: uuid("idea_id"),
    /** The #222 account this brief is for (soft reference). */
    accountId: text("account_id").notNull(),
    accountName: text("account_name").notNull(),
    accountDomain: text("account_domain").notNull().default(""),
    /** The resolved buyer — a public contact id from #222 (soft reference). */
    buyerContactId: text("buyer_contact_id").notNull(),
    buyerName: text("buyer_name").notNull(),
    buyerTitle: text("buyer_title").notNull().default(""),
    buyerRole: text("buyer_role", { enum: BUYER_ROLES }).notNull(),
    /** Falsifiable "why this person" rationale. */
    rationale: text("rationale").notNull(),
    /** Bounded topic tags — what this buyer/account cares about. */
    caresAbout: jsonb("cares_about").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The angle hooks (each with cited source URL + sanitized evidence). */
    hooks: jsonb("hooks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    /** Higher-priority roles that were absent (the fallback trail). */
    fallbackTrail: jsonb("fallback_trail").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("buyer_briefs_workspace_idx").on(t.workspaceId, t.createdAt),
    byWorkspaceAccount: index("buyer_briefs_workspace_account_idx").on(t.workspaceId, t.accountId),
    roleCk: check(
      "buyer_briefs_role_ck",
      sql`${t.buyerRole} IN ('champion','economic_buyer','agency','marketing','other')`,
    ),
  }),
);
