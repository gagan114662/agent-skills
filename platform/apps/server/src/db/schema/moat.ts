import { pgTable, uuid, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";
import { ventureIdeas } from "./venture.js";

/**
 * Moat-accrual ledger (#103, ADR-0103). One workspace-scoped table: the append-only record of concrete
 * moat accruals per venture, with provenance. The pure score (`moat/score.ts`) is a projection of these
 * rows; the Founder Console (#104) reads them to flag ventures that have stopped compounding. All
 * `workspace_id`-scoped with `onDelete: cascade` (the #3 tenant boundary); `venture_idea_id` cascades so
 * a venture's accruals die with it.
 */

export const MOAT_DIMENSIONS_DB = [
  "proprietaryData",
  "switchingCosts",
  "distributionLockIn",
  "accumulatedEvals",
] as const;

export const moatLedger = pgTable(
  "moat_ledger",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureIdeaId: uuid("venture_idea_id")
      .notNull()
      .references(() => ventureIdeas.id, { onDelete: "cascade" }),
    dimension: text("dimension", { enum: MOAT_DIMENSIONS_DB }).notNull(),
    /** The size of the accrual in `unit` terms (≥ 0). */
    magnitude: integer("magnitude").notNull(),
    unit: text("unit").notNull(),
    description: text("description").notNull().default(""),
    /** Where the accrual came from (the pipeline / attestation / network it was measured on). */
    provenance: text("provenance").notNull(),
    /** Optional pointer to the source artifact (a link/id). */
    sourceRef: text("source_ref"),
    createdByMemberId: uuid("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byVenture: index("moat_ledger_workspace_venture_idx").on(t.workspaceId, t.ventureIdeaId),
    byDimension: index("moat_ledger_workspace_dimension_idx").on(t.workspaceId, t.dimension),
    byCreated: index("moat_ledger_workspace_created_idx").on(t.workspaceId, t.createdAt),
    dimensionCk: check(
      "moat_ledger_dimension_ck",
      sql`${t.dimension} IN ('proprietaryData','switchingCosts','distributionLockIn','accumulatedEvals')`,
    ),
    magnitudeCk: check("moat_ledger_magnitude_ck", sql`${t.magnitude} >= 0`),
  }),
);
