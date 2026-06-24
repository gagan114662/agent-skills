import { buildMarketingSend, type MarketingSendKind } from "../marketing/external-send.js";
import type { GrowthCaps } from "./caps.js";
import {
  funnelFromEvents,
  growthToVentureSignal,
  recommendExperiments,
  scoreGrowth,
  sourceMetricsFromEvents,
} from "./score.js";
import type {
  ExperimentStatus,
  FunnelRates,
  GrowthEventKind,
  GrowthEventRecord,
  GrowthExperimentRecord,
  GrowthExperimentSuggestion,
  GrowthFunnel,
  GrowthSourceMetric,
} from "./types.js";

/**
 * The Growth Loop IO orchestrator (#102, ADR-0102). Declares one seam per side effect (the event log,
 * the experiment ledger, the #13 external-post gate) and a config-resolved {@link GrowthCaps}; the pure
 * funnel/score/recommend math lives in `score.ts`. So the service runs against fakes in tests and the
 * real repos in `default.ts`. Recording + reading are always available; the `caps.enabled` flag gates
 * the proactive posture only (mirrors how #119 keeps evidence recording always-on).
 */

export interface GrowthEventStore {
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    kind: GrowthEventKind;
    source: string;
    value: number;
    metadata: Record<string, unknown>;
    occurredAt: Date;
  }): Promise<GrowthEventRecord>;
  list(workspaceId: string, ideaId?: string): Promise<GrowthEventRecord[]>;
}

export interface GrowthExperimentStore {
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    channel: string;
    hypothesis: string;
    variant: string;
    metricKey: string;
    targetQuery: string;
    targetSource: string;
    proposedByMemberId: string | null;
  }): Promise<GrowthExperimentRecord>;
  get(workspaceId: string, id: string): Promise<GrowthExperimentRecord | undefined>;
  list(workspaceId: string): Promise<GrowthExperimentRecord[]>;
  linkApproval(
    workspaceId: string,
    id: string,
    approvalRequestId: string,
    now: Date,
  ): Promise<GrowthExperimentRecord | undefined>;
  updateStatus(
    workspaceId: string,
    id: string,
    status: ExperimentStatus,
    resultSummary: string,
    now: Date,
  ): Promise<GrowthExperimentRecord | undefined>;
  complete(
    workspaceId: string,
    id: string,
    result: string,
    decision: string,
    now: Date,
  ): Promise<GrowthExperimentRecord | undefined>;
}

/**
 * The #13 gate seam: submit the (always-gated) `external.send` action for a human to approve and post.
 * The descriptor is built by the existing `buildMarketingSend` (so the gate + executor are untouched).
 */
export interface ExternalPostGate {
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    actionType: "external.send";
    amount: number | null;
    payload: Record<string, unknown>;
    summary: string;
  }): Promise<{ id: string }>;
}

export interface GrowthDeps {
  events: GrowthEventStore;
  experiments: GrowthExperimentStore;
  gate: ExternalPostGate;
  caps: (workspaceId: string) => GrowthCaps;
  now?: () => Date;
}

/** One attribution source's aggregated weight (acquisition only — "where did the traffic come from"). */
export interface SourceWeight {
  source: string;
  value: number;
}

/** The growth summary surfaced to a route / the portfolio loop (#107) / the Founder Console (#104). */
export interface GrowthSummary {
  workspaceId: string;
  ideaId: string | null;
  funnel: GrowthFunnel;
  rates: FunnelRates;
  /** The 0–100 growth score. */
  score: number;
  /** The 0–10 distribution signal for the #96 venture scorecard. */
  ventureSignal: number;
  /** Top acquisition sources by weight, descending. */
  topSources: SourceWeight[];
  /** Per-source funnel and conversion-rate readout for cohort quality. */
  sourceMetrics: GrowthSourceMetric[];
  experiments: GrowthExperimentRecord[];
  /** Up to three next experiments, weakest funnel stage first (the growth tick's "next 3"). */
  recommendations: GrowthExperimentSuggestion[];
}

export interface AutoPauseDecision {
  experiment: GrowthExperimentRecord;
  acquisitions: number;
  conversions: number;
  conversionRate: number;
  threshold: number;
  reason: string;
  notified: true;
}

export class GrowthExperimentNotFoundError extends Error {
  constructor(id: string) {
    super(`growth experiment not found: ${id}`);
    this.name = "GrowthExperimentNotFoundError";
  }
}

export class GrowthExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowthExperimentValidationError";
  }
}

/** Aggregate acquisition events by source, descending, capped to the top five. */
function topSources(events: readonly GrowthEventRecord[]): SourceWeight[] {
  const bySource = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== "acquisition" || e.value <= 0) continue;
    const source = e.source || "(unattributed)";
    bySource.set(source, (bySource.get(source) ?? 0) + e.value);
  }
  return [...bySource.entries()]
    .map(([source, value]) => ({ source, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

function eventTargetsExperiment(event: GrowthEventRecord, experiment: GrowthExperimentRecord): boolean {
  const metadata = event.metadata ?? {};
  return [metadata.experimentId, metadata.campaignId, metadata.contentId].some(
    (value) => typeof value === "string" && value === experiment.id,
  );
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

function underperformerReason(input: {
  experiment: GrowthExperimentRecord;
  acquisitions: number;
  conversions: number;
  conversionRate: number;
  threshold: number;
}): string {
  const noun = input.conversions === 1 ? "conversion" : "conversions";
  return (
    "Auto-paused " +
    input.experiment.channel +
    " campaign/content because it produced " +
    input.conversions +
    " " +
    noun +
    " from " +
    input.acquisitions +
    " acquisitions (" +
    pct(input.conversionRate) +
    "), below the " +
    pct(input.threshold) +
    " threshold after the fair-sample floor."
  );
}

export class GrowthService {
  private readonly deps: GrowthDeps;
  private readonly now: () => Date;

  constructor(deps: GrowthDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Record one growth event (instrumentation ingest). Always available, tenant-scoped. */
  async recordEvent(
    workspaceId: string,
    input: {
      ideaId?: string | null;
      kind: GrowthEventKind;
      source?: string;
      value?: number;
      metadata?: Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<GrowthEventRecord> {
    return this.deps.events.insert({
      workspaceId,
      ideaId: input.ideaId ?? null,
      kind: input.kind,
      source: input.source ?? "",
      // a count event defaults to weight 1; negatives are clamped to 0 (the funnel ignores them anyway)
      value: typeof input.value === "number" ? Math.max(0, Math.trunc(input.value)) : 1,
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt ?? this.now(),
    });
  }

  /** Aggregate the funnel + score + recommendations for a workspace (or one venture idea). Read-only. */
  async summary(workspaceId: string, ideaId?: string): Promise<GrowthSummary> {
    const [events, experiments] = await Promise.all([
      this.deps.events.list(workspaceId, ideaId),
      this.deps.experiments.list(workspaceId),
    ]);
    const caps = this.deps.caps(workspaceId);
    const funnel = funnelFromEvents(events);
    const { score, rates } = scoreGrowth(funnel, caps);
    const scopedExperiments =
      ideaId === undefined ? experiments : experiments.filter((e) => e.ideaId === ideaId);
    return {
      workspaceId,
      ideaId: ideaId ?? null,
      funnel,
      rates,
      score,
      ventureSignal: growthToVentureSignal(score),
      topSources: topSources(events),
      sourceMetrics: sourceMetricsFromEvents(events),
      experiments: scopedExperiments,
      recommendations: recommendExperiments(funnel),
    };
  }

  /** Record a channel experiment proposed by a marketing agent (#123). */
  async proposeExperiment(
    workspaceId: string,
    input: {
      ideaId?: string | null;
      channel: string;
      hypothesis: string;
      variant?: string;
      metricKey?: string;
      targetQuery?: string;
      targetSource?: string;
      proposedByMemberId?: string | null;
    },
  ): Promise<GrowthExperimentRecord> {
    return this.deps.experiments.insert({
      workspaceId,
      ideaId: input.ideaId ?? null,
      channel: input.channel,
      hypothesis: input.hypothesis,
      variant: input.variant ?? "",
      metricKey: input.metricKey ?? "",
      targetQuery: input.targetQuery ?? "",
      targetSource: input.targetSource ?? "",
      proposedByMemberId: input.proposedByMemberId ?? null,
    });
  }

  async listExperiments(workspaceId: string): Promise<GrowthExperimentRecord[]> {
    return this.deps.experiments.list(workspaceId);
  }

  async completeExperiment(
    workspaceId: string,
    experimentId: string,
    input: { result: string; decision: string },
  ): Promise<GrowthExperimentRecord> {
    const result = input.result.trim();
    const decision = input.decision.trim();
    if (!result) throw new GrowthExperimentValidationError("result is required");
    if (!decision) throw new GrowthExperimentValidationError("decision is required");
    const completed = await this.deps.experiments.complete(
      workspaceId,
      experimentId,
      result,
      decision,
      this.now(),
    );
    if (!completed) throw new GrowthExperimentNotFoundError(experimentId);
    return completed;
  }

  /**
   * Auto-kill losing campaign/content experiments (#617). Conservative by design: the growth loop must be
   * enabled, the experiment must already be running, and only events explicitly attributed to the same
   * experiment/campaign/content id count toward the fair sample. The returned decisions are the notification
   * payload: the caller can show exactly why an item was paused.
   */
  async autoPauseUnderperformers(workspaceId: string): Promise<AutoPauseDecision[]> {
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return [];

    const [events, experiments] = await Promise.all([
      this.deps.events.list(workspaceId),
      this.deps.experiments.list(workspaceId),
    ]);
    const decisions: AutoPauseDecision[] = [];
    for (const experiment of experiments) {
      if (experiment.status !== "running") continue;
      const attributed = events.filter((event) => eventTargetsExperiment(event, experiment));
      const acquisitions = attributed
        .filter((event) => event.kind === "acquisition")
        .reduce((sum, event) => sum + Math.max(0, event.value), 0);
      if (acquisitions < caps.autoPauseMinAcquisitions) continue;

      const conversions = attributed
        .filter((event) => event.kind === "conversion")
        .reduce((sum, event) => sum + Math.max(0, event.value), 0);
      const conversionRate = acquisitions > 0 ? conversions / acquisitions : 0;
      if (conversionRate >= caps.autoPauseMaxConversionRate) continue;

      const reason = underperformerReason({
        experiment,
        acquisitions,
        conversions,
        conversionRate,
        threshold: caps.autoPauseMaxConversionRate,
      });
      const paused =
        (await this.deps.experiments.updateStatus(
          workspaceId,
          experiment.id,
          "paused",
          reason,
          this.now(),
        )) ?? { ...experiment, status: "paused" as const, resultSummary: reason, updatedAt: this.now() };
      decisions.push({
        experiment: paused,
        acquisitions,
        conversions,
        conversionRate,
        threshold: caps.autoPauseMaxConversionRate,
        reason,
        notified: true,
      });
    }
    return decisions;
  }

  /**
   * Promote an experiment to an external post. Builds the existing `external.send` descriptor and
   * submits it to the #13 gate (sensitive-by-default → a human approves + posts; an agent never
   * publishes autonomously), then links the gated request back onto the experiment.
   */
  async requestExternalPost(
    workspaceId: string,
    experimentId: string,
    input: {
      requesterMemberId: string;
      kind: MarketingSendKind;
      summary: string;
      target?: string;
      amountCents?: number;
    },
  ): Promise<{ approvalRequestId: string; experiment: GrowthExperimentRecord }> {
    const experiment = await this.deps.experiments.get(workspaceId, experimentId);
    if (!experiment) throw new GrowthExperimentNotFoundError(experimentId);

    const descriptor = buildMarketingSend({
      kind: input.kind,
      summary: input.summary,
      target: input.target,
      amountCents: input.amountCents,
    });
    const req = await this.deps.gate.submit({
      workspaceId,
      requesterMemberId: input.requesterMemberId,
      actionType: descriptor.actionType,
      amount: descriptor.amount,
      payload: { ...descriptor.payload, experimentId, channel: experiment.channel },
      summary: `Growth experiment "${experiment.channel}": ${input.summary}`,
    });
    const updated = await this.deps.experiments.linkApproval(
      workspaceId,
      experimentId,
      req.id,
      this.now(),
    );
    return { approvalRequestId: req.id, experiment: updated ?? experiment };
  }
}
