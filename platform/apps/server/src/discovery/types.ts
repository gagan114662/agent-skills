import type { DiscoveryDefKind, DiscoverySignalKind, GtmStage } from "./score.js";

/**
 * Persistence record shapes for the Customer Discovery Engine (#222) — what the repo returns and the
 * service/seams pass around. The pure scorer input shapes (ms-epoch timestamps) live in `score.ts`; these
 * carry `Date`s and the full row. Re-exported kinds keep one import site for consumers (#223/#225).
 */

export type { DiscoveryDefKind, DiscoverySignalKind, GtmStage } from "./score.js";

export interface DiscoverySignalRecord {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  prospectKey: string;
  kind: DiscoverySignalKind;
  value: number;
  role: string | null;
  source: string;
  externalRef: string | null;
  occurredAt: Date;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export interface SignalDefRecord {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  kind: DiscoveryDefKind;
  label: string;
  threshold: number;
  windowDays: number;
  role: string | null;
  weight: number;
  enabled: boolean;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PqlEventRecord {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  prospectKey: string;
  defId: string | null;
  defKind: string;
  score: number;
  verified: boolean;
  qualifyingSignals: string[];
  occurredAt: Date;
  createdAt: Date;
}

export interface PipelineEntryRecord {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  prospectKey: string;
  stage: GtmStage;
  verified: boolean;
  externalRef: string | null;
  enteredAt: Date;
  createdAt: Date;
}
