/**
 * Shared types for the Workspace Catalog (#152, ADR-0152). The catalog is a structured registry of the
 * workspace's marketing assets that agents read for context and workflows read as facts. These mirror
 * the `catalog_entries` table; the pure `caps` module and the IO repo agree on them.
 */

/** The asset kinds the catalog tracks. Must stay in sync with the `catalog_entries_kind_ck` CHECK. */
export const CATALOG_KINDS = [
  "site",
  "brand_kit",
  "social_account",
  "email_domain",
  "ad_account",
  "analytics_property",
  "venture",
  "deployed_app",
  "repo",
  "other",
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export function isCatalogKind(value: unknown): value is CatalogKind {
  return typeof value === "string" && (CATALOG_KINDS as readonly string[]).includes(value);
}

/** The lifecycle status of an asset. */
export const CATALOG_STATUSES = ["active", "inactive", "pending", "archived"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export function isCatalogStatus(value: unknown): value is CatalogStatus {
  return typeof value === "string" && (CATALOG_STATUSES as readonly string[]).includes(value);
}

/** How a row got into the catalog: owner-entered, integration-synced, or agent-discovered. */
export const CATALOG_PROVENANCES = ["manual", "synced", "agent"] as const;
export type CatalogProvenance = (typeof CATALOG_PROVENANCES)[number];

export function isCatalogProvenance(value: unknown): value is CatalogProvenance {
  return typeof value === "string" && (CATALOG_PROVENANCES as readonly string[]).includes(value);
}

/** A durable catalog row. */
export interface CatalogEntry {
  id: string;
  workspaceId: string;
  kind: CatalogKind;
  name: string;
  /** The canonical handle/URL (e.g. `https://ipop.ai`, `@ipop`). */
  identifier: string;
  status: CatalogStatus;
  provenance: CatalogProvenance;
  ownerMemberId: string | null;
  metadata: Record<string, string>;
  createdByMemberId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The fields a create/update accepts (id/workspace/timestamps are server-owned). */
export interface CatalogEntryInput {
  kind: CatalogKind;
  name: string;
  identifier?: string;
  status?: CatalogStatus;
  provenance?: CatalogProvenance;
  ownerMemberId?: string | null;
  metadata?: Record<string, string>;
}
