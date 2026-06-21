/**
 * Trace payload redaction (issue #560) — the write-site gate that keeps the observation trace from ever
 * becoming a secret-exfil channel (#25 boundary: "secrets never persisted in snapshots or logs", #200
 * user-facing rule).
 *
 * Two defenses, both applied before any event payload is persisted:
 *   1. Known secret VALUES are masked everywhere they appear — reusing the #25 redactor
 *      (`runtime/redact.ts redactSecrets`), the same one the runtime already uses on agent stdout/stderr.
 *   2. Sensitive KEYS (authorization, api_key, token, password, cookie…) are masked regardless of value —
 *      defense-in-depth for a secret we were never handed (e.g. a tool echoing a header it fetched).
 *
 * Pure + total: same input ⇒ same output, never mutates the input. Long strings are capped so a single
 * event can't store an unbounded blob.
 */
import { redactSecrets, REDACTION_MASK } from "../runtime/redact.js";

/** Replacement for a value held under a sensitive key (distinct from the value-match mask for clarity). */
export const SENSITIVE_KEY_MASK = "‹redacted-key›";

/** The longest a single string value may be once stored (a trace is a log, not a blob store). */
export const TRACE_STRING_MAX = 16_000;

/** Keys whose value is a secret regardless of content. Matched case-insensitively as a substring. */
const SENSITIVE_KEY_RE =
  /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|cookie|set-cookie|bearer|private[-_]?key|client[-_]?secret|session[-_]?token)/i;

function capString(s: string): string {
  if (s.length <= TRACE_STRING_MAX) return s;
  return `${s.slice(0, TRACE_STRING_MAX - 1)}…`;
}

function redactValue(value: unknown, secretValues: readonly string[]): unknown {
  if (typeof value === "string") {
    return capString(secretValues.length ? redactSecrets(value, secretValues) : value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secretValues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? SENSITIVE_KEY_MASK : redactValue(v, secretValues);
    }
    return out;
  }
  // numbers, booleans, null, undefined — nothing to redact.
  return value;
}

/**
 * Redact a structured event payload before it is persisted. `secretValues` are the run's known secret
 * values (env injected at provision time); pass an empty list when none are known — the key-scrubber still
 * runs. Returns a new object; the input is never mutated.
 */
export function redactTracePayload(
  payload: Record<string, unknown>,
  secretValues: readonly string[],
): Record<string, unknown> {
  const filtered = secretValues.filter((v) => typeof v === "string" && v.length > 0);
  return redactValue(payload, filtered) as Record<string, unknown>;
}

export { REDACTION_MASK };
