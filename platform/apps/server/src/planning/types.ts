/**
 * Shared types for the Product Planning Loop (#115, ADR-0115). The pure `rice`/`decide`/`spec` modules
 * and the IO `service`/`default` agree on these — mirroring the #117 flywheel / #102 growth `types.ts`
 * split (const-tuple taxonomies + `is*` guards, row-mirroring records, pure derived views at the
 * bottom).
 */

/**
 * Where a backlog item came from. Bounded + stable (each a CHECK value): `customer_voice` (#114
 * insights), `growth` (#102 funnel gaps), `verifier` (#106 outcome-verifier gaps), `manual` (a human
 * or agent added it directly). #106/#114 are forward-looking sources — first-class so their readers can
 * call `addItem(...)` when they land (the seam is the contract).
 */
export const BACKLOG_SOURCES = ["customer_voice", "growth", "verifier", "manual"] as const;
export type BacklogSource = (typeof BACKLOG_SOURCES)[number];

export function isBacklogSource(value: unknown): value is BacklogSource {
  return typeof value === "string" && (BACKLOG_SOURCES as readonly string[]).includes(value);
}

/**
 * Lifecycle of a backlog item: `proposed` (sourced, awaiting planning) → `specced` (a spec was drafted)
 * → `dispatched` (a build session was launched). `done`/`rejected` are terminal.
 */
export const BACKLOG_STATUSES = ["proposed", "specced", "dispatched", "done", "rejected"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

export function isBacklogStatus(value: unknown): value is BacklogStatus {
  return typeof value === "string" && (BACKLOG_STATUSES as readonly string[]).includes(value);
}

/** Lifecycle of a drafted spec: `draft` (awaiting/queued dispatch) → `dispatched` (a session launched). */
export const SPEC_STATUSES = ["draft", "dispatched"] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

export function isSpecStatus(value: unknown): value is SpecStatus {
  return typeof value === "string" && (SPEC_STATUSES as readonly string[]).includes(value);
}

/** One backlog item (one row in `backlog_items`) — the durable, workspace-scoped candidate unit of work. */
export interface BacklogItemRecord {
  id: string;
  workspaceId: string;
  /** The venture idea (#96) this item belongs to (soft reference), or null for workspace-level. */
  ideaId: string | null;
  title: string;
  description: string;
  source: BacklogSource;
  /** A link to the evidence (insight id / growth experiment id / verifier result id); the why-ranked-here. */
  sourceRef: string;
  // ---- RICE evidence inputs (stored; the pure `rice.ts` scores them) ----
  /** Distinct corroborating signals pointing at this item (the Reach input). */
  reach: number;
  /** Gap severity tier 0–4 (the Impact input; mapped to the standard RICE multiplier by the scorer). */
  impact: number;
  /** Corroboration percentage 0–100 (the Confidence input; the scorer divides by 100). */
  confidencePct: number;
  /** The agent's effort estimate in points (≥ 1; the RICE denominator). */
  effort: number;
  /** A pivot changes product direction — always a human call (sensitive-by-default in the dispatch). */
  isPivot: boolean;
  status: BacklogStatus;
  /** The channel a build session is launched into (soft reference), or null. */
  targetChannelId: string | null;
  /** The agent member a build session runs as (soft reference), or null. */
  targetAgentMemberId: string | null;
  /** The drafted spec (soft reference), or null until the planning tick drafts one. */
  specId: string | null;
  /** The #13 approval request gating this item's dispatch (soft reference), or null. */
  approvalRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One drafted spec (one row in `planning_specs`). */
export interface PlanningSpecRecord {
  id: string;
  workspaceId: string;
  /** The backlog item this spec was drafted for (soft reference). */
  backlogItemId: string;
  title: string;
  /** The spec body in the repo lifecycle format (markdown). */
  body: string;
  status: SpecStatus;
  /** The proposed build session (soft reference), or null until dispatched. */
  sessionId: string | null;
  /** The #13 approval request gating the dispatch (soft reference), or null. */
  approvalRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---- pure derived views ------------------------------------------------------------------------

/** Raw evidence counts a source adapter gathers, before `deriveRice` turns them into stored inputs. */
export interface BacklogEvidence {
  /** Distinct customer/demand signals → Reach. */
  signalCount: number;
  /** Gap severity tier 0–4 → Impact. */
  severityTier: number;
  /** Distinct independent evidence sources corroborating → Confidence. */
  corroboratingSources: number;
  /** The agent's effort estimate in points → Effort. */
  effortPoints: number;
}

/** The evidence-derived inputs stored on a backlog item (the columns `deriveRice` produces). */
export interface RiceItemInputs {
  reach: number;
  impact: number;
  confidencePct: number;
  effort: number;
}

/** The canonical RICE values a stored item resolves to (for display alongside the score). */
export interface RiceBreakdown {
  reach: number;
  /** The impact multiplier the severity tier maps to (0.25 / 0.5 / 1 / 2 / 3). */
  impact: number;
  /** The confidence fraction (confidencePct / 100, in [0,1]). */
  confidence: number;
  effort: number;
}

/** A backlog item with its computed RICE score + breakdown (the ranked view). */
export interface RankedBacklogItem {
  item: BacklogItemRecord;
  score: number;
  rice: RiceBreakdown;
  /** 1-based rank position in the backlog (1 = highest priority). */
  position: number;
}
