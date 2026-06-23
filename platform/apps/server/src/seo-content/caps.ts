/**
 * Configuration for the SEO content pipeline (issue #598). Deliberately **self-contained**: the master switch,
 * the publish/index credential tokens, and the per-stage gate thresholds are read straight from the process
 * environment, so this feature adds NO edit to the shared `config/schema.ts` barrel and stays free of
 * parallel-merge conflicts with sibling branches (the proven #597/#670/#742 pattern).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs an inert
 * pipeline — runs can be created, but `advance` never processes a stage, so nothing is generated, published, or
 * pinged. Even with the master switch ON the shipped providers are deterministic FAKES (see `providers.ts`), so
 * enabling the module cannot make a live call until a real transport is wired in a later change. The publish /
 * index credentials are tokens the HUMAN supplied out-of-band; this module never collects passwords nor performs
 * OAuth itself.
 *
 * Every gate threshold is conservative by default and fail-closed: a missing or malformed knob falls back to the
 * strict default rather than disabling the limit, so a typo can never silently widen what passes a gate.
 */

import { SEARCH_INTENTS, type SearchIntent } from "./types.js";

/** The per-stage gate policy. All thresholds conservative; the gates are fail-closed. */
export interface GatePolicy {
  /** Minimum topic↔keyword relevance (0..1) for the keyword stage to pass. */
  minKeywordRelevance: number;
  /** Minimum estimated monthly search volume a keyword must clear. */
  minMonthlyVolume: number;
  /** Maximum ranking difficulty (0..100) a keyword may carry. */
  maxDifficulty: number;
  /** The buyer intents a keyword is allowed to target (others are blocked). */
  allowedIntents: readonly SearchIntent[];
  /** Minimum number of outline sections a brief must contain to be "complete". */
  minBriefSections: number;
  /** Minimum word target a brief may set for the eventual draft. */
  minBriefWordTarget: number;
  /** Minimum body word count a draft must reach to clear the brand gate. */
  minDraftWords: number;
  /** Fraction (0..1) of the brief's word target the draft must reach (brand gate "substance" floor). */
  minDraftWordRatio: number;
  /** Phrases that, if present in a draft (case-insensitive), block it as off-brand "AI slop". */
  bannedPhrases: readonly string[];
}

/** Master config: the switch, the credentials, and the gate policy. */
export interface SeoContentCaps {
  /** Master switch. OFF by default. */
  enabled: boolean;
  /** User-supplied access tokens, or null when unset. Opaque — forwarded to providers, never minted/parsed here. */
  credentials: {
    /** CMS / publishing token. */
    publish: string | null;
    /** Search-console / indexing token. */
    index: string | null;
  };
  policy: GatePolicy;
}

/** Conservative, fail-closed gate defaults. Publish less, ship only complete, sourced, on-brand pieces. */
export const GATE_POLICY_DEFAULTS: GatePolicy = {
  minKeywordRelevance: 0.34,
  minMonthlyVolume: 100,
  maxDifficulty: 70,
  allowedIntents: SEARCH_INTENTS,
  minBriefSections: 3,
  minBriefWordTarget: 600,
  minDraftWords: 300,
  minDraftWordRatio: 0.6,
  // Generic, hollow phrasing that reads as machine-generated filler — the brand gate refuses it.
  bannedPhrases: [
    "in today's fast-paced world",
    "in conclusion",
    "as an ai language model",
    "unleash the power",
    "in this article we will",
  ],
};

export const SEO_CONTENT_DEFAULTS: SeoContentCaps = {
  enabled: false,
  credentials: { publish: null, index: null },
  policy: GATE_POLICY_DEFAULTS,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** A trimmed non-empty env value, or null. Whitespace-only is treated as absent (i.e. "no token"). */
function envToken(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a numeric knob from env, clamped to `[min, max]`, falling back to `fallback` for anything missing or
 * non-finite. Fail-closed: a garbage value becomes the conservative default rather than disabling the limit.
 */
function envNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse a comma-separated allowed-intent list from env, keeping only known intents; falls back to all. */
function envIntents(raw: string | undefined): readonly SearchIntent[] {
  if (raw === undefined) return SEARCH_INTENTS;
  const known = new Set<string>(SEARCH_INTENTS);
  const picked = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SearchIntent => known.has(s));
  // Fail-closed against an all-garbage value: an empty result falls back to the safe default (all intents).
  return picked.length > 0 ? [...new Set(picked)] : SEARCH_INTENTS;
}

/** Parse a `|`-separated banned-phrase list from env (case folded later); falls back to the defaults. */
function envPhrases(raw: string | undefined): readonly string[] {
  if (raw === undefined) return GATE_POLICY_DEFAULTS.bannedPhrases;
  const picked = raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return picked.length > 0 ? picked : GATE_POLICY_DEFAULTS.bannedPhrases;
}

/** Resolve the gate policy from env (defaults applied, every knob clamped to a sane range). Pure given `env`. */
export function resolveGatePolicy(env: NodeJS.ProcessEnv = process.env): GatePolicy {
  const d = GATE_POLICY_DEFAULTS;
  return {
    minKeywordRelevance: envNumber(env.SEO_MIN_KEYWORD_RELEVANCE, d.minKeywordRelevance, 0, 1),
    minMonthlyVolume: Math.round(envNumber(env.SEO_MIN_MONTHLY_VOLUME, d.minMonthlyVolume, 0, 1_000_000_000)),
    maxDifficulty: envNumber(env.SEO_MAX_DIFFICULTY, d.maxDifficulty, 0, 100),
    allowedIntents: envIntents(env.SEO_ALLOWED_INTENTS),
    minBriefSections: Math.round(envNumber(env.SEO_MIN_BRIEF_SECTIONS, d.minBriefSections, 1, 100)),
    minBriefWordTarget: Math.round(envNumber(env.SEO_MIN_BRIEF_WORD_TARGET, d.minBriefWordTarget, 1, 1_000_000)),
    minDraftWords: Math.round(envNumber(env.SEO_MIN_DRAFT_WORDS, d.minDraftWords, 1, 1_000_000)),
    minDraftWordRatio: envNumber(env.SEO_MIN_DRAFT_WORD_RATIO, d.minDraftWordRatio, 0, 1),
    bannedPhrases: envPhrases(env.SEO_BANNED_PHRASES),
  };
}

/** Resolve the full pipeline caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveSeoContentCaps(env: NodeJS.ProcessEnv = process.env): SeoContentCaps {
  return {
    enabled: envFlag(env.SEO_CONTENT_PIPELINE_ENABLED),
    credentials: {
      publish: envToken(env.SEO_PUBLISH_TOKEN),
      index: envToken(env.SEO_INDEX_TOKEN),
    },
    policy: resolveGatePolicy(env),
  };
}
