/**
 * Per-template approval for outbound email (issue #594).
 *
 * #594's acceptance is explicit: "unapproved templates are blocked". A new outreach template — or any
 * *edit* to an approved one — is a new way to reach strangers at scale, so it must clear a human
 * before it can be sent. This module makes "approved" a property of the template's exact content, not
 * just its id: the approval is keyed by a content fingerprint, so changing the subject or body of an
 * approved template silently invalidates the approval and forces re-review. That closes the obvious
 * bypass (approve a benign draft, then swap the body).
 *
 * Pure fingerprinting + a tiny read interface ({@link TemplateApprovalRegistry}) so any backing store
 * can satisfy it. {@link InMemoryTemplateApprovalRegistry} is dependency-free and self-contained — no
 * DB, migration, schema barrel, or app registry. Fingerprinting uses only `node:crypto`.
 */

import { createHash } from "node:crypto";

/** An outbound email template. `id` scopes the approval; `subject`+`body` are the content that is fingerprinted. */
export interface EmailTemplate {
  id: string;
  subject: string;
  body: string;
}

/** A recorded template approval. */
export interface TemplateApprovalRecord {
  /** Who approved this exact template content. */
  approvedBy: string;
  /** When it was approved (epoch ms). */
  at: number;
}

/** The read interface the template gate consults. */
export interface TemplateApprovalRegistry {
  /** Is the template with this content fingerprint approved? */
  isApproved(fingerprint: string): boolean;
}

/**
 * A stable content fingerprint for a template: a sha256 over the id and the whitespace-normalized
 * subject + body. Trimming and collapsing runs of whitespace means cosmetic reformatting does not
 * churn the fingerprint, while any real wording change does — so re-approval is required exactly when
 * the message a recipient sees changes. Total + pure.
 */
export function fingerprintTemplate(template: EmailTemplate): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const canonical = JSON.stringify({
    id: template.id.trim(),
    subject: norm(template.subject ?? ""),
    body: norm(template.body ?? ""),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface TemplateGateDecision {
  /** True only when the template's exact current content is approved. */
  approved: boolean;
  /** The content fingerprint the decision was made against. */
  fingerprint: string;
  /** True when approval is still needed (i.e. the content is not yet approved) — the inverse of `approved`. */
  requiresApproval: boolean;
  /** Human-readable reason (empty-ish "approved" when cleared). */
  reason: string;
}

/**
 * The per-template approval gate. Blocks any template whose exact content fingerprint is not in the
 * registry — i.e. a brand-new template, or an edited (re-fingerprinted) version of an approved one.
 * Total + pure.
 */
export function evaluateTemplate(
  registry: TemplateApprovalRegistry,
  template: EmailTemplate,
): TemplateGateDecision {
  const fingerprint = fingerprintTemplate(template);
  const approved = registry.isApproved(fingerprint);
  return {
    approved,
    fingerprint,
    requiresApproval: !approved,
    reason: approved
      ? "template content approved"
      : `template "${template.id}" requires owner approval before sending (content not yet approved)`,
  };
}

/**
 * A dependency-free, self-contained {@link TemplateApprovalRegistry} backed by an in-memory set of
 * approved fingerprints. Owns its own state — no DB, migration, schema barrel, or app registry.
 */
export class InMemoryTemplateApprovalRegistry implements TemplateApprovalRegistry {
  private readonly approved = new Map<string, TemplateApprovalRecord>();

  isApproved(fingerprint: string): boolean {
    return this.approved.has(fingerprint);
  }

  /** Record approval of an exact template content fingerprint. */
  approve(fingerprint: string, record: TemplateApprovalRecord): void {
    this.approved.set(fingerprint, record);
  }

  /** Revoke a previously-approved fingerprint (blocks the template again). */
  revoke(fingerprint: string): void {
    this.approved.delete(fingerprint);
  }
}
