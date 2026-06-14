import { FounderBriefingsService } from "./service.js";
import { FounderBriefingsEngine } from "./engine.js";
import { resolveBriefingsCaps } from "./caps.js";
import {
  MultiChannelBriefingNotifier,
  NoopSlackDeliverer,
  type SlackDeliverer,
} from "./notifier.js";
import type { SlackEventService } from "../slack/service.js";
import type { DecisionItem, VentureKpiSnapshot } from "./aggregate.js";
import type { Scale } from "../scale/default.js";
import type { BillingManager } from "../billing/manager.js";
import type { PortfolioService } from "../portfolio/service.js";
import type { SessionLogger } from "../runtime/manager.js";
import { loadConfig } from "../config/loader.js";
import { windowKey } from "../scale/usage.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { buildLoopRunStore } from "../db/repositories/build-loop.js";
import { listRequests } from "../db/repositories/approvals.js";
import { listOpenViolations } from "../db/repositories/constitution.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { listEvaluations, listIterations } from "../db/repositories/venture.js";
import { dbInsightStore } from "../db/repositories/voice.js";
import { listBacklogItems } from "../db/repositories/planning.js";
import { rankBacklog } from "../planning/rice.js";
import { getWorkspaceOwnerContact } from "../db/repositories/reliability.js";
import { selectPagerTransport } from "../reliability/pager/transport.js";
import { dbDeliveryStore } from "../db/repositories/founder-briefings.js";
import { buildAcquisitionBriefSection } from "../acquisition/default.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { getMaintenanceState } from "../maintenance/flag.js";

/**
 * Production wiring for Founder Briefings (#173, ADR-0173). Every read seam is backed by an EXISTING
 * repo/manager — no new query authority. The decision queue composes the #13 approvals + #172 guardrail
 * escalations + #146 constitution/pricing flags; the daily brief reads #172 ships, #71 spend, #146
 * violations; the weekly report reads #107 P&L + #96 movement + #98 revenue + #114 voice + #115 backlog.
 * Delivery reuses the #148 email-first transport to the resolved owner AND — when the workspace has
 * connected Slack (#170) — DMs the brief to the owner over the SAME #170 authority (`sendOwnerDm`).
 * Read-only throughout; the only write is the delivery audit (`dbDeliveryStore`).
 */
/**
 * Adapt the live #170 {@link SlackEventService} to the briefing {@link SlackDeliverer} seam: DM the
 * brief body to the workspace owner via `sendOwnerDm` (the same owner-DM authority the Slack digest
 * uses). A workspace that hasn't connected Slack resolves `{ sent: false }` → audited `not_connected`.
 */
export function slackBriefingDeliverer(slack: SlackEventService): SlackDeliverer {
  return {
    async deliver(input) {
      const { sent } = await slack.sendOwnerDm(input.workspaceId, { text: input.body });
      return { channel: "slack", delivered: sent, reason: sent ? "dm_sent" : "not_connected" };
    },
  };
}

export function createDefaultFounderBriefingsService(deps: {
  logger: SessionLogger;
  scale: Scale;
  billing: BillingManager;
  /** The #107 portfolio service — per-venture P&L + kill/scale decision (read-only). Absent ⇒ no P&L. */
  portfolio?: PortfolioService;
  /** The brand the company speaks as (brand voice). Default `ipop`. */
  brandName?: string;
  /**
   * The live #170 Slack service. When present, the brief is DM'd to the owner via `sendOwnerDm` (the
   * SAME owner-DM authority the Slack digest uses) — a no-op `{ sent:false, not_connected }` for any
   * workspace that hasn't connected Slack. Absent ⇒ the email channel is the only channel.
   */
  slack?: SlackEventService;
  /** Optional SMTP sender for the #148 email transport. Absent ⇒ the log transport (CI-safe). */
  sendMail?: Parameters<typeof selectPagerTransport>[0]["sendMail"];
  now?: () => Date;
}): FounderBriefingsService {
  const { scale, billing, portfolio, logger } = deps;
  const brandName = deps.brandName ?? "ipop";
  const currencyOf = (workspaceId: string): string =>
    loadConfig(workspaceId).billing?.currency ?? "usd";

  return new FounderBriefingsService({
    caps: (workspaceId) => resolveBriefingsCaps(loadConfig(workspaceId).briefings),
    brandName,
    // #172 ships: the merged self-shipping runs (newest first), as "what shipped".
    ships: {
      shipped: async (workspaceId) =>
        (await buildLoopRunStore.listForConsole(workspaceId))
          .filter((r) => r.status === "merged")
          .slice(0, 10)
          .map((r) => ({ title: r.issueTitle, ref: r.prRef ?? r.issueRef })),
    },
    // #172 blockers: the escalated runs handed to the owner (outside guardrails / max rounds).
    blocks: {
      blocked: async (workspaceId) =>
        (await buildLoopRunStore.listForConsole(workspaceId))
          .filter((r) => r.status === "escalated")
          .slice(0, 10)
          .map((r) => ({
            title: r.issueTitle,
            reason: r.escalationReason ?? "escalated",
            ref: r.prRef ?? r.issueRef,
          })),
    },
    // The ONE decision queue: #13 approvals + #172 guardrail escalations + #146 constitution/pricing.
    decisions: {
      items: async (workspaceId) => {
        const [approvals, runs, violations] = await Promise.all([
          listRequests(workspaceId, { status: "pending" }),
          buildLoopRunStore.listForConsole(workspaceId),
          listOpenViolations(workspaceId),
        ]);
        const items: DecisionItem[] = [];
        for (const a of approvals) {
          items.push({
            kind: "approval",
            id: a.id,
            title: a.summary,
            impact: a.amount !== null && a.amount > 0 ? "high" : "normal",
            createdAtMs: a.createdAt.getTime(),
            link: `/workspaces/${workspaceId}/approvals/${a.id}`,
          });
        }
        for (const r of runs.filter((x) => x.status === "escalated")) {
          items.push({
            kind: "guardrail_escalation",
            id: r.id,
            title: `${r.issueTitle} — ${r.escalationReason ?? "escalated"}`,
            impact: "high",
            createdAtMs: r.updatedAt.getTime(),
            link: r.prRef ?? `/workspaces/${workspaceId}/build-loop`,
          });
        }
        for (const v of violations) {
          items.push({
            kind: "constitution",
            id: v.id,
            title: `${v.article} ${v.code}: ${v.message}`,
            impact: v.severity === "block" ? "critical" : v.severity === "high" ? "high" : "normal",
            createdAtMs: v.createdAtMs,
            link: `/workspaces/${workspaceId}/founder-console`,
          });
        }
        return items;
      },
    },
    // #71 spend vs the resolved #71 budget cap (the SAME scale policy admission enforces).
    spend: {
      window: (now) => windowKey(now),
      usage: async (workspaceId, window) => {
        const u = await getUsage(workspaceId, window);
        return { estimatedCostCents: u.estimatedCostCents };
      },
      budgetCents: (workspaceId) => resolveScaleCaps(scale.config(workspaceId).scale).budgetCents,
      currency: currencyOf,
    },
    // #146 constitution: open (un-acknowledged) violations — the count + distinct codes.
    constitution: {
      summary: async (workspaceId) => {
        const open = await listOpenViolations(workspaceId);
        return { open: open.length, topCodes: [...new Set(open.map((v) => v.code))] };
      },
    },
    // #96/#98/#107/#71 per-venture KPI: the latest portfolio review (P&L + decision) joined to the
    // venture evaluation (status + score) + the prior pass's score (#96) for scorecard movement.
    ventures: {
      ventures: async (workspaceId) => {
        const evals = (await listEvaluations(workspaceId)).slice(0, 50);
        const reviews = portfolio ? await portfolio.listReviews(workspaceId) : [];
        const latestReview = new Map<string, (typeof reviews)[number]>();
        for (const r of reviews) {
          if (!latestReview.has(r.ventureIdeaId)) latestReview.set(r.ventureIdeaId, r); // newest-first
        }
        return Promise.all(
          evals.map(async (e): Promise<VentureKpiSnapshot> => {
            const rev = latestReview.get(e.ideaId);
            const iterations = await listIterations(workspaceId, e.ideaId);
            const scores = iterations.map((i) => i.score);
            const currentScore = e.lastScore ?? (scores.length > 0 ? scores[scores.length - 1]! : null);
            const previousScore = scores.length >= 2 ? scores[scores.length - 2]! : null;
            return {
              ideaId: e.ideaId,
              status: e.status,
              decision: rev?.decision ?? null,
              currentScore,
              previousScore,
              revenueCents: rev?.revenueCents ?? null,
              costCents: rev?.monthlyCostCents ?? null,
            };
          }),
        );
      },
    },
    // #98 revenue: workspace-level total (no per-venture split — see ADR-0107).
    revenue: {
      total: async (workspaceId) => {
        const r = await billing.revenue(workspaceId);
        return { totalCents: r.totalCents, currency: r.currency };
      },
    },
    // #114 voice: the top customer-voice signals — high-churn / negative first, then newest.
    voice: {
      signals: async (workspaceId, limit) => {
        const insights = await dbInsightStore.list(workspaceId);
        const priority = (s: { churnRisk: string; sentiment: string }): number =>
          (s.churnRisk === "high" ? 0 : 1) + (s.sentiment === "negative" ? 0 : 1);
        return [...insights]
          .sort((a, b) => priority(a) - priority(b))
          .slice(0, limit)
          .map((i) => ({ summary: i.summary, sentiment: i.sentiment, churnRisk: i.churnRisk }));
      },
    },
    // #115 backlog: the ranked, not-yet-dispatched items — next week's planned work (top by RICE).
    backlog: {
      upcoming: async (workspaceId, limit) => {
        const ranked = rankBacklog(await listBacklogItems(workspaceId));
        return ranked
          .filter((r) => r.item.status !== "dispatched")
          .slice(0, limit)
          .map((r) => ({ title: r.item.title, score: r.score, position: r.position }));
      },
    },
    // #148 delivery: email-first to the resolved owner (log transport in CI/privacy mode) + optional Slack.
    notifier: new MultiChannelBriefingNotifier({
      ownerContact: { resolve: (workspaceId) => getWorkspaceOwnerContact(workspaceId) },
      transport: selectPagerTransport({ logger, sendMail: deps.sendMail }),
      slack: deps.slack ? slackBriefingDeliverer(deps.slack) : new NoopSlackDeliverer(),
    }),
    deliveries: dbDeliveryStore,
    // #189 acquisition execution (AC5): real channel spend + CAC + failing channels. Returns null when
    // there is nothing to report (no spend/conversions/failures), so the brief is unchanged when idle.
    acquisition: {
      section: (workspaceId) => buildAcquisitionBriefSection(workspaceId),
    },
    now: deps.now,
  });
}

/**
 * Production wiring for the scheduled tick: iterate every workspace, maintenance-paused (#99) first. The
 * timer is started in `index.ts` only when `BRIEFINGS_INTERVAL_MS > 0` (default OFF); the per-workspace
 * `briefings.enabled` caps flag gates the actual delivery, and the idempotency watermark dedups repeats.
 */
export function createDefaultFounderBriefingsEngine(
  logger: SessionLogger,
  service: FounderBriefingsService,
): FounderBriefingsEngine {
  return new FounderBriefingsEngine({
    service,
    listWorkspaceIds,
    maintenancePaused: async () => (await getMaintenanceState()).enabled,
    logger,
  });
}
