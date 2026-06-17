/**
 * SEO rank ingest decision (#294) — pure, no IO. Turns the untrusted rows a {@link RankTrackingProvider}
 * (or an external webhook / owner paste) returns into validated {@link RankObservation} receipts ready to
 * persist. Every field is sanitised here (premortem §6): a hostile provider response can change WHAT is
 * recorded as a ranking, but it can never inject control characters, oversize a row, smuggle in an unknown
 * search engine, or — most importantly — become an instruction that triggers a send or spend downstream.
 *
 * A row is DROPPED (not guessed) when it lacks the two things that make it a real external receipt: a
 * non-empty keyword+URL pair and the provider's own `externalId`. A missing/invalid position is recorded
 * as `null` (an honest "not ranking"), never fabricated.
 */
import {
  type ProviderRankRow,
  type RankObservation,
  type RankProviderKind,
  type SearchEngine,
  isSearchEngine,
  sanitizeField,
  MAX_KEYWORD_LEN,
  MAX_URL_LEN,
  MAX_EXTERNAL_ID_LEN,
} from "./types.js";

export interface RankIngestOptions {
  provider: RankProviderKind;
  /** Default search engine when a row omits it. */
  defaultSearchEngine?: SearchEngine;
  /** Default market/country code when a row omits it. */
  defaultCountry?: string;
  /** Wall-clock now (ms) — used when a row carries no observation time. */
  nowMs: number;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeCountry(v: unknown, fallback: string): string {
  const s = asString(v);
  if (!s) return fallback;
  const c = s.trim().toLowerCase().slice(0, 8);
  return c || fallback;
}

function normalizePosition(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const p = Math.trunc(v);
  return p >= 1 ? p : null;
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeDetail(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 20) break; // cap key count
    const key = sanitizeField(k, 64);
    if (!key) continue;
    const str = typeof val === "string" ? val : typeof val === "number" ? String(val) : "";
    out[key] = sanitizeField(str, 512);
    n += 1;
  }
  return out;
}

/** Validate + sanitise one untrusted row into a receipt, or null to drop it. */
export function decideRankObservation(
  row: ProviderRankRow,
  opts: RankIngestOptions,
): RankObservation | null {
  const keyword = sanitizeField(asString(row.keyword) ?? "", MAX_KEYWORD_LEN);
  if (!keyword) return null;

  const url = sanitizeField(asString(row.url) ?? "", MAX_URL_LEN);
  if (!url || !isHttpUrl(url)) return null;

  const externalId = sanitizeField(asString(row.externalId) ?? "", MAX_EXTERNAL_ID_LEN);
  if (!externalId) return null; // no external id ⇒ not an external receipt ⇒ untrusted ⇒ drop

  const seRaw = asString(row.searchEngine);
  const searchEngine: SearchEngine =
    seRaw && isSearchEngine(seRaw.toLowerCase())
      ? (seRaw.toLowerCase() as SearchEngine)
      : opts.defaultSearchEngine ?? "google";

  const observedAtMs =
    typeof row.observedAtMs === "number" && Number.isFinite(row.observedAtMs) && row.observedAtMs > 0
      ? Math.trunc(row.observedAtMs)
      : opts.nowMs;

  return {
    keyword,
    url,
    position: normalizePosition(row.position),
    searchEngine,
    country: normalizeCountry(row.country, opts.defaultCountry ?? "us"),
    provider: opts.provider,
    externalId,
    observedAtMs,
    detail: sanitizeDetail(row.detail),
  };
}

/** Validate + sanitise a batch, dropping any row that isn't a real external receipt. */
export function decideRankIngest(
  rows: ReadonlyArray<ProviderRankRow>,
  opts: RankIngestOptions,
): RankObservation[] {
  const out: RankObservation[] = [];
  for (const row of rows) {
    const obs = decideRankObservation(row, opts);
    if (obs) out.push(obs);
  }
  return out;
}
