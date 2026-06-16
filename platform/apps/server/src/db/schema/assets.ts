import { pgTable, uuid, text, boolean, timestamp, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";

/**
 * Brand kit + asset store (#271). Two workspace-scoped tables that give the marketing fleet (Quill,
 * Echo, Bid, and Mark) the brand assets they need.
 *
 *  - `brand_kits` — the one-time brand identity the OWNER sets: palette (hex colours), voice, and an
 *    optional logo (a soft ref to a stored asset). Mark enforces it; the other agents draw from it so
 *    everything they generate is on-brand. A workspace has at most ONE `active` kit (a partial unique
 *    index), with older versions kept `archived` for provenance. The brand-kit's existence is exactly
 *    what flips the founder-console brand proof tile from "not connected" to connected (#253).
 *
 *  - `workspace_assets` — the per-workspace store of GENERATED and UPLOADED assets. `generated` rows are
 *    produced by the (default-OFF) `generate_image` tool through an {@link ImageProvider}; `uploaded`
 *    rows are owner uploads (e.g. the logo). `on_brand` records Mark's verdict at store time; `brand_kit_id`
 *    stamps which kit the asset was checked against (provenance). `draft_ref` is the soft link to the
 *    `agent.deliverable` approval card (#248/#251) an asset was attached to — this is how an agent's
 *    generated image rides along with the draft it illustrates.
 *
 * Only `workspace_id` carries the #3 tenant boundary (ON DELETE CASCADE). `venture_id` / `logo_asset_id`
 * / `brand_kit_id` / `draft_ref` are SOFT refs (no FK) so an asset receipt outlives a pruned
 * venture/approval. The table names are deliberately NOT `venture_`/`growth_`-prefixed so the #155
 * colocation gate does not class them as governed metric surfaces.
 */

/** How an asset entered the store. `generated` ⇒ produced by `generate_image`; `uploaded` ⇒ owner upload. */
export const ASSET_KINDS = ["generated", "uploaded"] as const;

/** The tool/source that produced the asset (mirrors the real-world tool vocabulary where applicable). */
export const ASSET_SOURCE_TOOLS = ["generate_image", "store_asset", "upload"] as const;

/** Brand-kit lifecycle. Exactly one `active` kit per workspace; superseded kits become `archived`. */
export const BRAND_KIT_STATUSES = ["active", "archived"] as const;

export const brandKits = pgTable(
  "brand_kits",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The brand display name (e.g. the product/company name the fleet writes as). */
    name: text("name").notNull(),
    /** The brand palette as an ordered list of `#rrggbb` hex colours (first = primary). */
    palette: jsonb("palette").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** The brand voice: tone + the do/don't the copy must follow (Mark enforces, the others draw from). */
    voice: text("voice").notNull().default(""),
    /** Optional logo — a SOFT ref to a `workspace_assets` row (an uploaded image). */
    logoAssetId: uuid("logo_asset_id"),
    status: text("status", { enum: BRAND_KIT_STATUSES }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("brand_kits_workspace_idx").on(t.workspaceId, t.createdAt),
    // At most one ACTIVE kit per workspace — the "set once" guarantee (re-setting archives the old one).
    oneActive: uniqueIndex("brand_kits_one_active_idx")
      .on(t.workspaceId)
      .where(sql`${t.status} = 'active'`),
    statusCk: check("brand_kits_status_ck", sql`${t.status} IN ('active','archived')`),
  }),
);

export const workspaceAssets = pgTable(
  "workspace_assets",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ventureId: uuid("venture_id"),
    kind: text("kind", { enum: ASSET_KINDS }).notNull(),
    /** MIME type of the stored bytes (e.g. `image/svg+xml`, `image/png`). */
    mime: text("mime").notNull(),
    title: text("title").notNull().default(""),
    /** The asset payload as a `data:`/`https:` URI (the dry-run provider stores an inline data-uri). */
    data: text("data").notNull(),
    /** Which brand kit this asset was checked against (provenance) — SOFT ref to `brand_kits`. */
    brandKitId: uuid("brand_kit_id"),
    /** Mark's verdict at store time: did the asset satisfy the active brand kit? */
    onBrand: boolean("on_brand").notNull().default(false),
    sourceTool: text("source_tool", { enum: ASSET_SOURCE_TOOLS }).notNull(),
    /** SOFT ref to the `agent.deliverable` approval card (#248) this asset was attached to, if any. */
    draftRef: uuid("draft_ref"),
    provider: text("provider").notNull().default(""),
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspaceCreated: index("workspace_assets_workspace_created_idx").on(t.workspaceId, t.createdAt),
    byDraft: index("workspace_assets_draft_idx").on(t.workspaceId, t.draftRef),
    kindCk: check("workspace_assets_kind_ck", sql`${t.kind} IN ('generated','uploaded')`),
    sourceCk: check(
      "workspace_assets_source_ck",
      sql`${t.sourceTool} IN ('generate_image','store_asset','upload')`,
    ),
  }),
);
