import type { Exposure } from "./chain.js";

/**
 * The durable exposure-store seam for the attributed-revenue ledger (#386, ADR-0386).
 *
 * An EXPOSURE is the head of the causal chain `artifact -> exposure -> signup -> payment`: a fleet
 * artifact shown to the world under a stable tracking ref (attribution/tracking.ts). This seam is the
 * ONLY write the attribution layer makes — it records an exposure when the fleet really ships something
 * live, and lists exposures for the projection. The DB-backed impl lives in
 * `db/repositories/attribution.ts`; unit tests inject an in-memory fake (no DB).
 *
 * Idempotent on `(workspaceId, trackingRef)` (the table's unique constraint): re-stamping the same
 * artifact records ONE exposure row, never a duplicate. Holds no secret and no money — only an artifact
 * id, a tracking ref, a channel, and timestamps.
 */
export interface RecordExposureInput {
  workspaceId: string;
  /** The fleet artifact this exposure attributes a future payment back to (post id, page path, PR url). */
  artifactId: string;
  artifactKind: string;
  /** The stable tracking ref minted for (workspace, artifact, channel) — the join key of the chain. */
  trackingRef: string;
  channel: string;
  /** When the artifact went live (epoch ms). Supplied by the caller's clock seam — pure core has no clock. */
  occurredAtMs: number;
}

export interface AttributionExposureStore {
  /** Idempotent record of one exposure on `(workspaceId, trackingRef)` (ON CONFLICT DO NOTHING). */
  recordExposure(input: RecordExposureInput): Promise<{ id: string }>;
  /** Workspace-scoped exposure read (IDOR-safe). `sinceMs` is an optional incremental cursor. */
  listExposures(workspaceId: string, sinceMs?: number): Promise<Exposure[]>;
}
