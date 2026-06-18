/**
 * #269 — the storage seams the {@link SocialPublishService} writes through. Interfaces only (no IO), so the
 * service is unit-testable against in-memory fakes and the DB repos (`db/repositories/social.ts`) are the
 * production wiring. Records are plain data — the service NEVER trusts a stored field to choose an action
 * (routing is structural, by id; targets are the stored allow-listed network list).
 */

import type { SocialNetwork, SocialPostStatus } from "./decide.js";

export interface SocialPostRecord {
  id: string;
  workspaceId: string;
  /** The post content (DATA). */
  body: string;
  /** The target networks for this post (the validated allow-list, order-stable). */
  networks: SocialNetwork[];
  /** ISO instant the post is scheduled for, or null for "post on approval". */
  scheduledAt: string | null;
  status: SocialPostStatus;
  /** The #13 approval that authorized the publish — the load-bearing proof a post only ships post-approval. */
  approvalRequestId: string | null;
  /** The aggregator's overall post id, set at publish — an EXTERNAL receipt the read-back verifies against. */
  aggregatorRef: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface SocialPostResultRecord {
  id: string;
  workspaceId: string;
  postId: string;
  network: SocialNetwork;
  status: "published" | "scheduled" | "failed";
  /** The network's real post id — the external receipt. */
  externalId: string | null;
  /** The live permalink read back from the aggregator. */
  permalink: string | null;
  error: string | null;
  /** ISO timestamp. */
  recordedAt: string;
}

export interface CreateSocialDraftInput {
  workspaceId: string;
  body: string;
  networks: SocialNetwork[];
  scheduledAt: string | null;
}

/** A status transition, with the fields each transition can carry (all optional but the status). */
export interface SocialPostStatusPatch {
  status: SocialPostStatus;
  approvalRequestId?: string | null;
  aggregatorRef?: string | null;
}

export interface RecordSocialResultInput {
  workspaceId: string;
  postId: string;
  network: SocialNetwork;
  status: "published" | "scheduled" | "failed";
  externalId: string | null;
  permalink: string | null;
  error: string | null;
}

export interface SocialPostStore {
  getById(id: string): Promise<SocialPostRecord | null>;
  createDraft(input: CreateSocialDraftInput): Promise<SocialPostRecord>;
  applyStatus(id: string, patch: SocialPostStatusPatch): Promise<SocialPostRecord | null>;
  listByWorkspace(workspaceId: string, limit?: number): Promise<SocialPostRecord[]>;
}

export interface SocialResultStore {
  /** Replace the recorded per-network receipts for a post (a publish is recorded atomically per attempt). */
  record(postId: string, results: readonly RecordSocialResultInput[]): Promise<void>;
  listForPost(postId: string): Promise<SocialPostResultRecord[]>;
  /** Count externally-verified `published` receipts for a workspace (the metric source — recorded rows only). */
  countPublishedForWorkspace(workspaceId: string): Promise<number>;
}
