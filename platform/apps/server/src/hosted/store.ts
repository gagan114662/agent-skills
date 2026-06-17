/**
 * #266 — the storage seams the {@link HostedPublishService} writes through. Interfaces only (no IO), so the
 * service is unit-testable against in-memory fakes and the DB repos (`db/repositories/hosted.ts`) are the
 * production wiring. Records are plain data — the service never trusts a stored field to choose an action.
 */

import type { HostedPageKind, HostedPageStatus } from "./decide.js";

export interface HostedSiteRecord {
  id: string;
  workspaceId: string;
  subdomain: string;
  customDomain: string | null;
  domainVerified: boolean;
  name: string;
}

export interface HostedPageRecord {
  id: string;
  workspaceId: string;
  siteId: string;
  kind: HostedPageKind;
  slug: string;
  title: string;
  body: string;
  description: string;
  status: HostedPageStatus;
  html: string | null;
  publicUrl: string | null;
  approvalRequestId: string | null;
  /** ISO timestamp, or null until published. */
  publishedAt: string | null;
}

export interface CreateHostedSiteInput {
  workspaceId: string;
  subdomain: string;
  customDomain?: string | null;
  name?: string;
}

export interface UpsertHostedDraftInput {
  workspaceId: string;
  siteId: string;
  kind: HostedPageKind;
  slug: string;
  title: string;
  body: string;
  description: string;
  html: string;
}

/** A status transition, with the fields each transition carries (all optional but the status). */
export interface HostedPageStatusPatch {
  status: HostedPageStatus;
  html?: string | null;
  publicUrl?: string | null;
  approvalRequestId?: string | null;
  publishedAt?: string | null;
}

export interface HostedSiteStore {
  getById(id: string): Promise<HostedSiteRecord | null>;
  getBySubdomain(subdomain: string): Promise<HostedSiteRecord | null>;
  getByCustomDomain(domain: string): Promise<HostedSiteRecord | null>;
  firstForWorkspace(workspaceId: string): Promise<HostedSiteRecord | null>;
  create(input: CreateHostedSiteInput): Promise<HostedSiteRecord>;
}

export interface HostedPageStore {
  getById(id: string): Promise<HostedPageRecord | null>;
  getBySiteSlug(siteId: string, slug: string): Promise<HostedPageRecord | null>;
  /** Create a fresh draft, or overwrite the draft fields of an existing (non-published) page at this slug. */
  upsertDraft(input: UpsertHostedDraftInput): Promise<HostedPageRecord>;
  applyStatus(id: string, patch: HostedPageStatusPatch): Promise<HostedPageRecord | null>;
  listByWorkspace(workspaceId: string, limit?: number): Promise<HostedPageRecord[]>;
}

export interface HostedViewStore {
  record(input: { workspaceId: string; pageId: string; referrer?: string | null }): Promise<void>;
  countForPage(pageId: string): Promise<number>;
  countForWorkspace(workspaceId: string): Promise<number>;
}
