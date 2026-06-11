/**
 * Semantic layer service (#155, ADR-0155 §2–3). The IO orchestrator: it routes a metric question to its
 * single canonical definition (the catalog), resolves the governed value through the injected
 * {@link MetricResolver} seam, then assembles a provenance-+-freshness-cited answer (pure `answer.ts`). This
 * is the structural routing the Anthropic playbook calls for — lens answers a metric question ONLY through
 * here, so the same number comes back everywhere, with its path and freshness flagged. Raw-data exploration
 * is the documented fallback, surfaced as a flagged `raw_data` answer.
 *
 * The service holds no governed logic of its own; the resolver (default wiring) reads the governed
 * summaries, and a test injects a deterministic fake. Reads are always-on + tenant-scoped (the route adds
 * the #19 `assertWorkspace` boundary); `caps.enabled` gates only the proactive eval tick, not answering.
 */

import { getMetric, listMetrics, type MetricDefinition } from "./catalog.js";
import { buildAnswer, type MetricAnswer, type ResolvedMetric } from "./answer.js";
import type { FleetCaps } from "./caps.js";

/** The governed-value seam: resolve one metric's canonical value + as-of for a workspace. */
export interface MetricResolver {
  resolve(workspaceId: string, def: MetricDefinition): Promise<ResolvedMetric>;
}

export interface SemanticLayerDeps {
  resolver: MetricResolver;
  caps: (workspaceId: string) => FleetCaps;
  /** Injectable clock for deterministic freshness in tests. */
  now?: () => Date;
}

export class SemanticLayerService {
  private readonly deps: SemanticLayerDeps;
  private readonly now: () => Date;

  constructor(deps: SemanticLayerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** The metric catalog (definitions only) — what lens can answer. Pure, no workspace needed. */
  catalog(): MetricDefinition[] {
    return listMetrics();
  }

  /**
   * Answer one metric question for a workspace. Returns `null` for an unknown metric id (the route maps it
   * to 404). A known metric always yields an answer — a governed value via `semantic_layer`, or a flagged
   * `raw_data` fallback when the resolver has no governed number.
   */
  async answer(workspaceId: string, metricId: string): Promise<MetricAnswer | null> {
    const def = getMetric(metricId);
    if (!def) return null;
    const caps = this.deps.caps(workspaceId);
    const resolved = await this.deps.resolver.resolve(workspaceId, def);
    return buildAnswer(def, resolved, this.now().getTime(), caps.freshnessMaxAgeMs);
  }

  /** Answer the whole catalog for a workspace (the lens analytics pane). */
  async answerAll(workspaceId: string): Promise<MetricAnswer[]> {
    const caps = this.deps.caps(workspaceId);
    const nowMs = this.now().getTime();
    const out: MetricAnswer[] = [];
    for (const def of listMetrics()) {
      const resolved = await this.deps.resolver.resolve(workspaceId, def);
      out.push(buildAnswer(def, resolved, nowMs, caps.freshnessMaxAgeMs));
    }
    return out;
  }
}
