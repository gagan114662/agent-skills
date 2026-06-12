/**
 * The IO paging orchestrator for the reliability surface (#148, ADR-0148). Resolves the workspace
 * owner's verified contact, applies the pure {@link decidePage} verdict (reading the recent page log
 * for the rate-limit window + the incident's ack/last-paged state), delivers through a
 * {@link PagerTransport}, and **always audits** the attempt (delivered or suppressed) into
 * `reliability_pages`. Used by BOTH the SRE coordinator and the uptime monitor (`source`).
 *
 * Pages go ONLY to the verified owner — there is no broadcast. A page with no resolvable owner is
 * audited as `no_owner` and dropped.
 */
import { decidePage, type PageKind, type PageSeverity } from "../paging/decide.js";
import type { ReliabilityCaps } from "../caps.js";
import type { OwnerContact } from "../../db/repositories/reliability.js";
import type { PagerTransport } from "./transport.js";

export type PageSource = "sre" | "uptime" | "selfqa";

export interface PagerDeps {
  ownerContact(workspaceId: string): Promise<OwnerContact | null>;
  caps(workspaceId: string): ReliabilityCaps;
  /** Pages delivered to the workspace since `since` (the rate-limit window). */
  recentPageCount(workspaceId: string, since: Date): Promise<number>;
  recordPage(input: {
    workspaceId: string;
    source: PageSource;
    incidentId: string | null;
    kind: PageKind;
    recipient: string;
    delivered: boolean;
    suppressedReason: string | null;
  }): Promise<void>;
  transport: PagerTransport;
  now?: () => Date;
}

export interface PageRequest {
  workspaceId: string;
  source: PageSource;
  incidentId: string | null;
  kind: PageKind;
  severity: PageSeverity;
  lastPagedAt: Date | null;
  ackedAt: Date | null;
  subject: string;
  body: string;
}

const RATE_WINDOW_MS = 60 * 60_000; // pages-per-rolling-hour

export class PagerService {
  private readonly now: () => Date;
  constructor(private readonly deps: PagerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async page(req: PageRequest): Promise<{ delivered: boolean; reason: string }> {
    const now = this.now();
    const caps = this.deps.caps(req.workspaceId);
    const owner = await this.deps.ownerContact(req.workspaceId);

    const recentPageCount = caps.enabled
      ? await this.deps.recentPageCount(req.workspaceId, new Date(now.getTime() - RATE_WINDOW_MS))
      : 0;

    const decision = decidePage({
      enabled: caps.enabled,
      now,
      kind: req.kind,
      severity: req.severity,
      quietHours: caps.quietHours,
      lastPagedAt: req.lastPagedAt,
      ackedAt: req.ackedAt,
      escalateAfterMs: caps.escalateAfterMs,
      recentPageCount,
      maxPagesPerWindow: caps.maxPagesPerHour,
      pageOnResolve: caps.pageOnResolve,
    });

    // Decided to deliver, but no verified owner ⇒ cannot page (audited as no_owner).
    let delivered = decision.deliver && owner !== null;
    let reason = decision.deliver && owner === null ? "no_owner" : decision.reason;

    if (delivered && owner) {
      try {
        await this.deps.transport.send({ to: owner.email, subject: req.subject, body: req.body });
      } catch {
        delivered = false;
        reason = "transport_error";
      }
    }

    await this.deps.recordPage({
      workspaceId: req.workspaceId,
      source: req.source,
      incidentId: req.incidentId,
      kind: req.kind,
      recipient: owner?.email ?? "unknown",
      delivered,
      suppressedReason: delivered ? null : reason,
    });

    return { delivered, reason };
  }
}
