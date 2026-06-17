import { pgTable, uuid, text, integer, jsonb, timestamp, unique, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * SEO rank tracking (#294, ADR-0294). One workspace-scoped table: `seo_rank_observations`.
 *
 * This is an EXTERNAL receipt store, exactly like `acquisition_send_receipts` (#189) and `reach_receipts`
 * (#280) — premortem #200 §2: a ranking only counts if it came from outside (a rank-tracking API / Search
 * Console), recorded with the provider's own id. Each row is one (keyword, url, position) reading a real
 * provider returned at `observed_at`. `position` is nullable = an honest "not ranking in the window"; a
 * `provider='dryrun'` deployment records nothing, so the founder console's SEO proof tile stays "not
 * connected" rather than showing a self-reported figure.
 *
 * The table name is deliberately `seo_*` (not `growth_*`/`venture_*`/`moat_*`/`demand_*`) so the #155
 * colocation gate does not class it as a governed metric surface. No FK beyond the tenant boundary.
 */
export const seoRankObservations = pgTable(
  "seo_rank_observations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The tracked search query (structural data — never an instruction). */
    keyword: text("keyword").notNull(),
    /** The ranking URL the provider attributed the position to. */
    url: text("url").notNull(),
    /** 1-based SERP position, or NULL = not ranking in the checked window (never fabricated). */
    position: integer("position"),
    searchEngine: text("search_engine", { enum: ["google", "bing"] }).notNull().default("google"),
    /** Market/country code the rank was checked in (e.g. 'us'). */
    country: text("country").notNull().default("us"),
    /** The provider that reported it (`dryrun` rows never exist; `search_console`|`serpapi`|`dataforseo`). */
    provider: text("provider").notNull(),
    /** The provider's own record id — the proof this came from outside. Part of the idempotency key. */
    externalId: text("external_id").notNull(),
    /** When the provider measured the rank (provider time, not insert time). */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    engineCk: check("seo_rank_observations_engine_ck", sql`${t.searchEngine} IN ('google','bing')`),
    // Idempotent ingest: re-reporting the same provider receipt upserts, never stacks.
    receiptUk: unique("seo_rank_observations_receipt_uk").on(t.workspaceId, t.provider, t.externalId),
    workspaceKeywordIdx: index("seo_rank_observations_workspace_keyword_idx").on(
      t.workspaceId,
      t.keyword,
      t.observedAt,
    ),
  }),
);
