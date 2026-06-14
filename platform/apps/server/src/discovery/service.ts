import type { GrowthEventKind } from "../growth/types.js";
import type { DiscoveryCaps } from "./caps.js";
import {
  detectQualifications,
  pipelineMetrics,
  rankProspects,
  type DiscoveryProspect,
  type DiscoverySignalInput,
  type GtmPipelineMetrics,
  type GtmStage,
  type SignalDefInput,
} from "./score.js";
import { isDiscoveryDefKind, isDiscoverySignalKind } from "./score.js";
import type {
  DiscoverySignalRecord,
  PipelineEntryRecord,
  PqlEventRecord,
  SignalDefRecord,
} from "./types.js";

/**
 * Customer Discovery Engine — IO orchestrator (#222, ADR-0222). Declares one seam per side effect (the
 * signal store, the definition store, the PQL ledger, the pipeline ledger, and the OPTIONAL growth-funnel
 * emitter) + a config-resolved {@link DiscoveryCaps}; the pure funnel/rank/qualify math lives in
 * `score.ts`. So the service runs against fakes in tests and the real repos in `default.ts`.
 *
 * READ-ONLY by design (premortem #200, issue scope): it ranks and surfaces; it NEVER sends — outreach is
 * #225. Signal ingest, the ranked queue, PQL detection and the growth emission are always live; `enabled`
 * gates only the proactive posture. The moment a real signal qualifies a prospect against an owner-defined
 * definition, a PQL event is emitted, the prospect enters the `outreach` GTM stage, and (when an emitter
 * is wired) a growth-funnel event lights up the founder-console growth panel (#104) — event-driven, never
 * a placeholder.
 */

export interface SignalStore {
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    prospectKey: string;
    kind: DiscoverySignalRecord["kind"];
    value: number;
    role: string | null;
    source: string;
    externalRef: string | null;
    occurredAt: Date;
    detail: Record<string, unknown>;
  }): Promise<DiscoverySignalRecord>;
  /** Every signal for one prospect (workspace-scoped; optionally narrowed to one venture idea). */
  listForProspect(
    workspaceId: string,
    prospectKey: string,
    ideaId?: string | null,
  ): Promise<DiscoverySignalRecord[]>;
  /** Every signal for the workspace, optionally narrowed to one venture idea. */
  list(workspaceId: string, ideaId?: string): Promise<DiscoverySignalRecord[]>;
}

export interface SignalDefStore {
  upsert(input: {
    workspaceId: string;
    ideaId: string | null;
    kind: SignalDefRecord["kind"];
    label: string;
    threshold: number;
    windowDays: number;
    role: string | null;
    weight: number;
    enabled: boolean;
    createdByMemberId: string | null;
  }): Promise<SignalDefRecord>;
  list(workspaceId: string): Promise<SignalDefRecord[]>;
}

export interface PqlStore {
  /** The `${prospectKey} ${defId}` keys already emitted (the idempotency set). */
  emittedKeys(workspaceId: string): Promise<Set<string>>;
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    prospectKey: string;
    defId: string | null;
    defKind: string;
    score: number;
    verified: boolean;
    qualifyingSignals: string[];
    occurredAt: Date;
  }): Promise<PqlEventRecord>;
  list(workspaceId: string, ideaId?: string): Promise<PqlEventRecord[]>;
}

export interface PipelineStore {
  /** Idempotently record a prospect entering a GTM stage (no-op if already there). */
  enter(input: {
    workspaceId: string;
    ideaId: string | null;
    prospectKey: string;
    stage: GtmStage;
    verified: boolean;
    externalRef: string | null;
    enteredAt: Date;
  }): Promise<void>;
  list(workspaceId: string, ideaId?: string): Promise<PipelineEntryRecord[]>;
}

/**
 * OPTIONAL bridge to the growth funnel (#102) — the seam that lights up the founder-console growth panel
 * (#104) with event-driven counts. Absent ⇒ discovery still works (ingest/queue/PQL), the console growth
 * panel just stays unfed by discovery. Wired in `default.ts` to `GrowthService.recordEvent`.
 */
export interface GrowthEmitter {
  record(
    workspaceId: string,
    input: {
      ideaId: string | null;
      kind: GrowthEventKind;
      source: string;
      value: number;
      metadata: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface DiscoveryDeps {
  signals: SignalStore;
  defs: SignalDefStore;
  pqls: PqlStore;
  pipeline: PipelineStore;
  /** Optional growth-funnel bridge (#102 → #104). Absent ⇒ no funnel emission. */
  growth?: GrowthEmitter;
  caps: (workspaceId: string) => DiscoveryCaps;
  now?: () => Date;
}

/** The daily ranked discovery queue (AC1/AC3) — every score is UNVERIFIED (a prediction). */
export interface DiscoveryQueue {
  workspaceId: string;
  ideaId: string | null;
  generatedAtMs: number;
  /** Always true: the likelihood scores are predictions, not externally-confirmed conversions. */
  unverified: true;
  prospects: DiscoveryProspect[];
}

/** The 5-stage GTM pipeline summary fed into the founder-console growth panel (#104). */
export interface GtmPipelineSummary {
  workspaceId: string;
  ideaId: string | null;
  metrics: GtmPipelineMetrics;
  /** Total PQL events emitted (the top of the pipeline). */
  pqlCount: number;
}

/** Thrown when a signal/definition fails validation (bad kind, empty key, or a PII-looking prospect key). */
export class DiscoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryValidationError";
  }
}

/**
 * Reject a prospect key that looks like PII (premortem guardrail: no PII in logs/URLs). The discovery
 * layer only ever stores an OPAQUE actor token — an email/phone-looking key is a caller bug, not data we
 * silently persist. (Detection is conservative: an '@' or a long digit run is enough to refuse.)
 */
function assertOpaqueProspectKey(prospectKey: string): void {
  const key = prospectKey.trim();
  if (key.length === 0) {
    throw new DiscoveryValidationError("prospectKey is required");
  }
  if (key.includes("@")) {
    throw new DiscoveryValidationError("prospectKey must be an opaque token, not an email (no PII)");
  }
  if (/\d{7,}/.test(key)) {
    throw new DiscoveryValidationError(
      "prospectKey must be an opaque token, not a phone/identifier with a long digit run (no PII)",
    );
  }
}

function toSignalInput(r: DiscoverySignalRecord): DiscoverySignalInput {
  return {
    prospectKey: r.prospectKey,
    kind: r.kind,
    value: r.value,
    role: r.role,
    externalRef: r.externalRef,
    occurredAtMs: r.occurredAt.getTime(),
  };
}

function toDefInput(r: SignalDefRecord): SignalDefInput {
  return {
    id: r.id,
    kind: r.kind,
    threshold: r.threshold,
    windowDays: r.windowDays,
    role: r.role,
    weight: r.weight,
    enabled: r.enabled,
  };
}

/** Definitions that apply to a signal/query scoped to `ideaId`: the idea's own + workspace-level (null). */
function applicableDefs(defs: SignalDefRecord[], ideaId: string | null): SignalDefRecord[] {
  if (ideaId === null) return defs;
  return defs.filter((d) => d.ideaId === null || d.ideaId === ideaId);
}

export class DiscoveryService {
  private readonly deps: DiscoveryDeps;
  private readonly now: () => Date;

  constructor(deps: DiscoveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Owner defines (or re-defines) a qualifying signal (AC1). One row per (workspace, idea, label). */
  async defineSignal(
    workspaceId: string,
    input: {
      ideaId?: string | null;
      kind: string;
      label: string;
      threshold?: number;
      windowDays?: number;
      role?: string | null;
      weight?: number;
      enabled?: boolean;
      createdByMemberId?: string | null;
    },
  ): Promise<SignalDefRecord> {
    if (!isDiscoveryDefKind(input.kind)) {
      throw new DiscoveryValidationError(
        "kind must be one of power_user_threshold, usage_trend, pricing_page_visit, role_match",
      );
    }
    const label = (input.label ?? "").trim();
    if (label.length === 0) throw new DiscoveryValidationError("label is required");
    const caps = this.deps.caps(workspaceId);
    const weight = clampInt(input.weight ?? 50, 0, 100);
    const windowDays = Math.max(1, Math.trunc(input.windowDays ?? caps.defaultWindowDays));
    const threshold = Math.max(1, Math.trunc(input.threshold ?? 1));
    return this.deps.defs.upsert({
      workspaceId,
      ideaId: input.ideaId ?? null,
      kind: input.kind,
      label,
      threshold,
      windowDays,
      role: input.role ? input.role.trim() : null,
      weight,
      enabled: input.enabled ?? true,
      createdByMemberId: input.createdByMemberId ?? null,
    });
  }

  async listSignalDefs(workspaceId: string): Promise<SignalDefRecord[]> {
    return this.deps.defs.list(workspaceId);
  }

  /**
   * Ingest ONE real product/channel receipt (AC1), then re-evaluate the owner's definitions for that
   * prospect: every NEW (prospect, def) qualification emits a PQL event, enters the prospect into the
   * `outreach` GTM stage, and (when an emitter is wired) records a growth `activation` event. A first-seen
   * prospect records a growth `acquisition` event; an externally-grounded `conversion` signal also enters
   * the `conversion` stage (verified) + records a growth `conversion` event. Never fabricates — every
   * emission is downstream of this real receipt.
   */
  async ingestSignal(
    workspaceId: string,
    input: {
      ideaId?: string | null;
      prospectKey: string;
      kind: string;
      value?: number;
      role?: string | null;
      source?: string;
      externalRef?: string | null;
      occurredAt?: Date;
      detail?: Record<string, unknown>;
    },
  ): Promise<{ signal: DiscoverySignalRecord; pqls: PqlEventRecord[] }> {
    if (!isDiscoverySignalKind(input.kind)) {
      throw new DiscoveryValidationError(
        "kind must be one of usage_event, pricing_page_visit, role_identified, conversion",
      );
    }
    assertOpaqueProspectKey(input.prospectKey);

    const ideaId = input.ideaId ?? null;
    const prospectKey = input.prospectKey.trim();
    const externalRef = input.externalRef && input.externalRef.trim().length > 0
      ? input.externalRef.trim()
      : null;
    const occurredAt = input.occurredAt ?? this.now();

    const signal = await this.deps.signals.insert({
      workspaceId,
      ideaId,
      prospectKey,
      kind: input.kind,
      value: typeof input.value === "number" ? Math.max(0, Math.trunc(input.value)) : 1,
      role: input.role ? input.role.trim() : null,
      source: (input.source ?? "").trim(),
      externalRef,
      occurredAt,
      detail: input.detail ?? {},
    });

    const prospectSignals = await this.deps.signals.listForProspect(workspaceId, prospectKey, ideaId);
    const nowMs = this.now().getTime();

    // First-seen prospect → a new lead entered the funnel (growth `acquisition`).
    if (prospectSignals.length === 1 && this.deps.growth) {
      await this.deps.growth.record(workspaceId, {
        ideaId,
        kind: "acquisition",
        source: signal.source || "discovery",
        value: 1,
        metadata: { prospectKey, signalKind: signal.kind },
      });
    }

    // Re-evaluate the owner's definitions for this prospect; emit PQLs for NEW qualifications only.
    const allDefs = await this.deps.defs.list(workspaceId);
    const defs = applicableDefs(allDefs, ideaId).map(toDefInput);
    const emitted = await this.deps.pqls.emittedKeys(workspaceId);
    const quals = detectQualifications(prospectSignals.map(toSignalInput), defs, { nowMs }, emitted);

    const pqls: PqlEventRecord[] = [];
    for (const q of quals) {
      const pql = await this.deps.pqls.insert({
        workspaceId,
        ideaId,
        prospectKey: q.prospectKey,
        defId: q.defId,
        defKind: q.defKind,
        score: q.score,
        verified: q.verified,
        qualifyingSignals: q.qualifyingSignalKinds,
        occurredAt,
      });
      pqls.push(pql);
      // A PQL is a "who to reach out to now" — it enters the top GTM stage (outreach). READ-ONLY: we do
      // NOT send; #225 actions the outreach. `verified` reflects whether a real receipt grounded it.
      await this.deps.pipeline.enter({
        workspaceId,
        ideaId,
        prospectKey: q.prospectKey,
        stage: "outreach",
        verified: q.verified,
        externalRef: null,
        enteredAt: occurredAt,
      });
      if (this.deps.growth) {
        await this.deps.growth.record(workspaceId, {
          ideaId,
          kind: "activation",
          source: "discovery",
          value: 1,
          metadata: { prospectKey: q.prospectKey, defKind: q.defKind },
        });
      }
    }

    // An externally-grounded conversion receipt advances the pipeline to `conversion` (verified) and
    // records a growth `conversion` event — the only externally-VERIFIED metric in the funnel.
    if (signal.kind === "conversion" && externalRef) {
      await this.deps.pipeline.enter({
        workspaceId,
        ideaId,
        prospectKey,
        stage: "conversion",
        verified: true,
        externalRef,
        enteredAt: occurredAt,
      });
      if (this.deps.growth) {
        await this.deps.growth.record(workspaceId, {
          ideaId,
          kind: "conversion",
          source: signal.source || "discovery",
          value: 1,
          metadata: { prospectKey, externalRef },
        });
      }
    }

    return { signal, pqls };
  }

  /**
   * The daily ranked discovery queue (AC1/AC3): the top-N prospects to reach out to now, each carrying its
   * qualifying definition(s) + signal kind(s) + an UNVERIFIED likelihood score. Read-only.
   */
  async queue(
    workspaceId: string,
    opts: { ideaId?: string; limit?: number } = {},
  ): Promise<DiscoveryQueue> {
    const ideaId = opts.ideaId ?? null;
    const caps = this.deps.caps(workspaceId);
    const [signals, allDefs] = await Promise.all([
      this.deps.signals.list(workspaceId, opts.ideaId),
      this.deps.defs.list(workspaceId),
    ]);
    const defs = applicableDefs(allDefs, ideaId).map(toDefInput);
    const nowMs = this.now().getTime();
    const limit = Math.max(1, Math.min(opts.limit ?? caps.queueLimit, caps.queueLimit));
    const prospects = rankProspects(signals.map(toSignalInput), defs, { nowMs, limit });
    return { workspaceId, ideaId, generatedAtMs: nowMs, unverified: true, prospects };
  }

  /** The 5-stage GTM pipeline metrics (per-stage counts + stage-to-stage conversions). Read-only. */
  async pipelineSummary(workspaceId: string, ideaId?: string): Promise<GtmPipelineSummary> {
    const [entries, pqls] = await Promise.all([
      this.deps.pipeline.list(workspaceId, ideaId),
      this.deps.pqls.list(workspaceId, ideaId),
    ]);
    const metrics = pipelineMetrics(
      entries.map((e) => ({ prospectKey: e.prospectKey, stage: e.stage, verified: e.verified })),
    );
    return { workspaceId, ideaId: ideaId ?? null, metrics, pqlCount: pqls.length };
  }

  /** The PQL event stream (the stable seam #223/#225 consume). Read-only. */
  async listPqlEvents(workspaceId: string, ideaId?: string): Promise<PqlEventRecord[]> {
    return this.deps.pqls.list(workspaceId, ideaId);
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
