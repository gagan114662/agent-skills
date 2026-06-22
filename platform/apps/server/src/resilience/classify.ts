/**
 * Pure failure classification (issues #637/#638). Given whatever an external call threw — a fetch-style
 * `{ status, headers }`, an `{ statusCode }`, a wrapped `{ response: { status, headers } }`, or a raw
 * Node socket error with a `code` — decide whether it is *transient* (safe to retry) and pull out any
 * `Retry-After` the server advertised. No IO and no implicit clock: date-form `Retry-After` needs the
 * current epoch-ms, which is passed in (`opts.nowMs`) so the function stays pure and testable.
 *
 * The classification is deliberately conservative: only 429, 5xx, request-timeout statuses and a known set
 * of connection-level error codes are retried. Everything else — 4xx, auth, validation, an unrecognised
 * error — is `permanent`, because retrying a request the server already rejected on its merits only burns
 * the attempt budget and delays the inevitable failure.
 */

import type { FailureClass, FailureKind } from "./types.js";

/** Connection-level error codes treated as transient (a fresh attempt may well connect). */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN", // temporary DNS failure (distinct from ENOTFOUND, which is a permanent lookup miss)
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", // undici connect timeout
  "UND_ERR_SOCKET",
]);

/** Read a header case-insensitively from a `Headers`-like object or a plain record. */
function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  // `Headers`-like (has a .get): use it directly (already case-insensitive).
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const v = (getter as (n: string) => unknown).call(headers, name);
    return typeof v === "string" ? v : null;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0];
      return null;
    }
  }
  return null;
}

/**
 * Parse a `Retry-After` header into milliseconds. Two forms per RFC 7231: a non-negative number of seconds
 * (`Retry-After: 120`) or an HTTP-date (`Retry-After: Wed, 21 Oct 2025 07:28:00 GMT`). The date form needs
 * `nowMs` to produce a relative delay; without it (or for a past date) we return null. Never negative.
 */
export function parseRetryAfterMs(raw: string | null, nowMs: number | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Numeric seconds.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date — needs a clock to make it relative.
  if (nowMs === null) return null;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/** Pull a numeric HTTP status off the various error shapes external clients throw. */
function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  const candidates = [e.status, e.statusCode, (e.response as Record<string, unknown> | undefined)?.status];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

/** Pull the headers off the various error shapes (top-level or nested under `response`). */
function extractHeaders(error: unknown): unknown {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;
  if (e.headers) return e.headers;
  const response = e.response as Record<string, unknown> | undefined;
  return response?.headers ?? null;
}

/** Pull a Node-style error `code` (e.g. `ECONNRESET`) off the error. */
function extractCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function classFor(kind: FailureKind, transient: boolean, status: number | null, retryAfterMs: number | null): FailureClass {
  return { transient, kind, status, retryAfterMs };
}

/**
 * Classify an arbitrary thrown value / error response. Pure given `opts.nowMs` (only consulted to resolve
 * a date-form `Retry-After`). Recognises, in order: HTTP status (429 ⇒ rate_limit, 408/425 ⇒ timeout,
 * 5xx ⇒ server, other 4xx ⇒ permanent), then transient network codes, then falls back to `permanent`.
 */
export function classifyFailure(error: unknown, opts: { nowMs?: number | null } = {}): FailureClass {
  const nowMs = opts.nowMs ?? null;
  const status = extractStatus(error);
  const retryAfterMs = parseRetryAfterMs(readHeader(extractHeaders(error), "retry-after"), nowMs);

  if (status !== null) {
    if (status === 429) return classFor("rate_limit", true, status, retryAfterMs);
    if (status === 408 || status === 425) return classFor("timeout", true, status, retryAfterMs);
    if (status >= 500 && status <= 599) return classFor("server", true, status, retryAfterMs);
    // Any other status (the 2xx/3xx that still surfaced as an error, or a 4xx the server rejected on
    // merits) is permanent — retrying will not change the outcome.
    return classFor("permanent", false, status, retryAfterMs);
  }

  const code = extractCode(error);
  if (code !== null && TRANSIENT_NETWORK_CODES.has(code)) {
    return classFor("network", true, null, retryAfterMs);
  }

  return classFor("permanent", false, null, retryAfterMs);
}
