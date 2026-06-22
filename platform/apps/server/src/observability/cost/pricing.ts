/**
 * Per-model token pricing + cost estimation (issue #667).
 *
 * This is the one place that turns "the model used N tokens" into "the run cost $X". The #560 trace already
 * persists `costMicros` per event when the writer computes it; this module computes it from the model id +
 * token counts when it was NOT pre-computed, so a run's cost is always derivable from what the trace captured.
 *
 * Cost is carried everywhere as integer **micro-dollars** (1e-6 USD) — the same unit the trace rollup uses
 * (`costMicros`) — so the entire pipeline stays integer and never accrues float drift across thousands of
 * events. The arithmetic is deliberately simple: a model's USD-per-million-tokens rate equals its
 * micro-dollars-per-token rate (price/1e6 * tokens * 1e6 = price * tokens), so `costMicros = tokens * usdPerMTok`.
 *
 * Rates are a static, self-contained table (no DB, no migration) matching the public Anthropic price list,
 * with an env override (`OBSERVABILITY_COST_PRICING_JSON`) for private/renegotiated rates. Unknown models
 * resolve by family (opus/sonnet/haiku/fable) and finally to a conservative default, so a never-before-seen
 * model id still produces a non-zero, clearly-flagged estimate rather than silently costing $0.
 */

/** A model's price, in USD per million tokens, split by token kind. */
export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  inputPerMTokUsd: number;
  /** USD per 1M output tokens. */
  outputPerMTokUsd: number;
}

/** Token usage for one model call. Every field is optional; missing → 0. */
export interface CostUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Tokens served from the prompt cache (billed at ~0.1x input). */
  cacheReadTokens?: number | null;
  /** Tokens written to the prompt cache (billed at ~1.25x input, 5-min TTL). */
  cacheWriteTokens?: number | null;
}

/** Cache pricing is a multiple of the input rate (Anthropic prompt-caching economics). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** How a model id resolved to a price — surfaced so the UI can flag estimates built on a fallback rate. */
export type PricingMatch = "exact" | "family" | "default";

/**
 * Built-in rate card (USD / 1M tokens), keyed by normalized model id. Mirrors the published Anthropic price
 * list. Kept here (not the DB) so the module is migration-free and self-contained.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTokUsd: 10, outputPerMTokUsd: 50 },
  "claude-opus-4-8": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-opus-4-7": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-opus-4-6": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-opus-4-5": { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  "claude-opus-4-1": { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  "claude-opus-4-0": { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  "claude-opus-3": { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
  "claude-sonnet-4-6": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-sonnet-4-5": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-sonnet-4-0": { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  "claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  "claude-haiku-3-5": { inputPerMTokUsd: 0.8, outputPerMTokUsd: 4 },
  "claude-haiku-3": { inputPerMTokUsd: 0.25, outputPerMTokUsd: 1.25 },
};

/** Per-family fallback rates for an unrecognized version within a known model family. */
const FAMILY_PRICING: Record<string, ModelPricing> = {
  fable: { inputPerMTokUsd: 10, outputPerMTokUsd: 50 },
  opus: { inputPerMTokUsd: 5, outputPerMTokUsd: 25 },
  sonnet: { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  haiku: { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
};

/** Last-resort rate for a model id that matches no known family. Conservative (Opus-tier) so cost isn't undercounted. */
export const DEFAULT_FALLBACK_PRICING: ModelPricing = { inputPerMTokUsd: 5, outputPerMTokUsd: 25 };

/**
 * Reduce a raw model identifier to its canonical key. Handles the shapes that flow through traces: the exact
 * `claude-opus-4-8` ids, harness-suffixed forms (`claude-opus-4-8[1m]`, `...-fast`, `...-latest`), Bedrock /
 * Vertex region+provider prefixes (`us.anthropic.claude-...`, `anthropic.claude-...`), Bedrock version tags
 * (`...-v2:0`), and dated snapshots (`claude-3-5-sonnet-20241022`). Returns `""` for empty/non-string input.
 */
export function normalizeModelId(model: string | null | undefined): string {
  if (!model) return "";
  let id = String(model).trim().toLowerCase();
  // region prefixes used by Bedrock cross-region inference profiles
  id = id.replace(/^(us|eu|apac|us-gov)\./, "");
  // provider prefix (Bedrock / Vertex)
  id = id.replace(/^anthropic\./, "");
  // harness/runtime bracket annotations, e.g. "[1m]"
  id = id.replace(/\[[^\]]*\]/g, "");
  // bedrock model version suffix, e.g. "-v2:0"
  id = id.replace(/-v\d+:\d+$/, "");
  // dated snapshot suffix, e.g. "-20241022"
  id = id.replace(/-\d{8}$/, "");
  // routing aliases
  id = id.replace(/-(fast|latest)$/, "");
  return id.trim();
}

/** Resolve a model id to its price and how the match was made. Never throws; never returns undefined. */
export function resolveModelPricing(model: string | null | undefined): {
  pricing: ModelPricing;
  match: PricingMatch;
  modelId: string;
} {
  const id = normalizeModelId(model);
  const overrides = loadPricingOverrides();

  const exact = overrides[id] ?? DEFAULT_PRICING[id];
  if (exact) return { pricing: exact, match: "exact", modelId: id || "unknown" };

  for (const family of Object.keys(FAMILY_PRICING)) {
    if (id.includes(family)) {
      return { pricing: FAMILY_PRICING[family]!, match: "family", modelId: id || family };
    }
  }
  return { pricing: DEFAULT_FALLBACK_PRICING, match: "default", modelId: id || "unknown" };
}

/**
 * Estimate the cost of one model call in integer micro-dollars. Because USD/MTok numerically equals
 * micro-USD/token, the cost is just `tokens * rate` summed across token kinds, then rounded.
 */
export function estimateCostMicros(model: string | null | undefined, usage: CostUsage): number {
  const { pricing } = resolveModelPricing(model);
  const input = Math.max(0, usage.inputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);

  const micros =
    input * pricing.inputPerMTokUsd +
    output * pricing.outputPerMTokUsd +
    cacheRead * pricing.inputPerMTokUsd * CACHE_READ_MULTIPLIER +
    cacheWrite * pricing.inputPerMTokUsd * CACHE_WRITE_MULTIPLIER;

  return Math.round(micros);
}

/** Render micro-dollars as a human-readable USD string, e.g. 12345 → "$0.012345". */
export function formatUsd(costMicros: number, fractionDigits = 6): string {
  const usd = (costMicros ?? 0) / 1_000_000;
  return `$${usd.toFixed(fractionDigits)}`;
}

/**
 * Parse the optional `OBSERVABILITY_COST_PRICING_JSON` env override (a JSON object of
 * `{ "<model-id>": { "inputPerMTokUsd": n, "outputPerMTokUsd": n } }`). Self-contained env-only config, in
 * the spirit of the other self-managed modules. Malformed/invalid entries are ignored (never throws) so a
 * bad override can never break cost accounting. Keys are normalized so callers can use any id shape.
 */
function loadPricingOverrides(): Record<string, ModelPricing> {
  const raw = process.env.OBSERVABILITY_COST_PRICING_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPricing>>;
    const out: Record<string, ModelPricing> = {};
    for (const [key, val] of Object.entries(parsed)) {
      const input = Number(val?.inputPerMTokUsd);
      const output = Number(val?.outputPerMTokUsd);
      if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
        out[normalizeModelId(key)] = { inputPerMTokUsd: input, outputPerMTokUsd: output };
      }
    }
    return out;
  } catch {
    return {};
  }
}
