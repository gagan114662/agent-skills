/**
 * Shared types for Venture Memory & Planning (#197, ADR-0197). The pure `memory`/`okr`/`plan`/`playbook`
 * modules and the IO `service`/`default` agree on these — mirroring the #115 planning `types.ts` split
 * (const-tuple taxonomies + `is*` guards, row-mirroring records, pure derived views). Self-contained: no
 * DB import, so the pure modules stay unit-testable without a database.
 */

// ---- venture memory (reuses the #15 `memories` table; see `memory.ts`) -------------------------

/**
 * The kind of a venture memory, stored in `memories.content.kind`. Bounded + stable: `decision` (a
 * choice + its why), `worked` / `failed` (a tried thing and its outcome), `customer_voice` (what a
 * customer said), `brand_fact` (a durable fact about the brand/product). The #15 `type` column is the
 * fixed `venture_memory`; this kind is the sub-taxonomy in the JSON content.
 */
export const VENTURE_MEMORY_KINDS = [
  "decision",
  "worked",
  "failed",
  "customer_voice",
  "brand_fact",
] as const;
export type VentureMemoryKind = (typeof VENTURE_MEMORY_KINDS)[number];

export function isVentureMemoryKind(value: unknown): value is VentureMemoryKind {
  return typeof value === "string" && (VENTURE_MEMORY_KINDS as readonly string[]).includes(value);
}

/** A venture memory — a #15 `memories` row reduced to what this subsystem reads/writes. */
export interface VentureMemoryEntry {
  id: string;
  ideaId: string;
  kind: VentureMemoryKind;
  /** The memory statement (the `content.text`). */
  text: string;
  /** Why a decision was made (only meaningful for `kind: decision`), or null. */
  why: string | null;
  /** A link to the evidence/source, or null. */
  sourceRef: string | null;
  createdAtMs: number;
  /** True when the node was superseded (#16) — stale, surfaced only in the "what does it believe" audit. */
  stale: boolean;
}

// ---- OKRs (`venture_okrs`) ---------------------------------------------------------------------

export type OkrStatus = "active" | "achieved" | "missed" | "archived";

/**
 * One key result. `verified` (an externally-verified #106 receipt) is the ONLY thing that lets it read
 * `on_track` in `computeOkrDrift` — a self-reported number is always flagged (premortem #200, mode 2).
 */
export interface KeyResult {
  metric: string;
  target: number;
  current: number;
  unit: string;
  verified: boolean;
  /** The #106 verifier-result id / external source, or null when self-reported. */
  source: string | null;
}

/** A persisted OKR (one row in `venture_okrs`). */
export interface OkrRecord {
  id: string;
  workspaceId: string;
  ideaId: string;
  objective: string;
  keyResults: KeyResult[];
  status: OkrStatus;
  periodKey: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- weekly plans (`venture_plans`) ------------------------------------------------------------

export type PlanStatus = "draft" | "approved" | "rejected" | "dispatched";
export type GoNoGo = "go" | "no_go";

/** One drafted plan item. `estimateLabel` is the literal `UNVERIFIED` (premortem #200, mode 2). */
export interface PlanItem {
  title: string;
  why: string;
  estimateLabel: "UNVERIFIED";
  /** Where the item came from (`memory` / `scorecard_gap` / `backlog` / `playbook`). */
  source: string;
  sourceRef: string;
  /** Evidence counts carried so #115 `deriveRice` can score the item when it's dispatched. */
  severityTier: number;
  signalCount: number;
  corroboratingSources: number;
  effortPoints: number;
}

/** A persisted weekly plan (one row in `venture_plans`). */
export interface PlanRecord {
  id: string;
  workspaceId: string;
  ideaId: string;
  weekKey: string;
  status: PlanStatus;
  goNoGo: GoNoGo;
  rationale: string;
  premortemCited: boolean;
  items: PlanItem[];
  approvalRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---- cross-venture playbooks (`venture_playbooks`) ---------------------------------------------

/** One provenance entry on a playbook: anonymized source-venture lineage + the #106 receipt. */
export interface PlaybookProvenance {
  /** A stable hash of the source venture id — lineage without leaking which venture. */
  sourceVentureHash: string;
  outcome: string;
  evidence: string;
  /** The #106 verifier-result id that earned the win, or null. */
  verifierResultId: string | null;
}

/** A persisted playbook (one row in `venture_playbooks`). */
export interface PlaybookRecord {
  id: string;
  workspaceId: string;
  category: string;
  pattern: string;
  provenance: PlaybookProvenance[];
  dedupeKey: string;
  createdAt: Date;
  updatedAt: Date;
}
