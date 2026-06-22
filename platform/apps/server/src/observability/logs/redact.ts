/**
 * Write-door redaction for the durable run-log store (issues #665/#666). Reuses the exact same defenses the
 * #560 trace applies, so a persisted log can never become a secret-exfil channel:
 *   - log line text → run known secret VALUES through the #25 redactor and cap the length (a log is a log,
 *     not a blob store);
 *   - failing-tool arguments → run the structured trace redactor, which masks sensitive KEYS
 *     (authorization, api_key, token…) and known secret values, and caps every string.
 *
 * Pure + total: same input ⇒ same output, never mutates the input.
 */
import { redactSecrets } from "../../runtime/redact.js";
import { redactTracePayload } from "../../trace/redact.js";

/** The longest a single persisted log line may be once stored. */
export const LOG_LINE_MAX = 8_000;

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Redact + length-cap one log line. `secretValues` are the run's known secrets (empty list ⇒ cap only). */
export function redactLogLine(text: string, secretValues: readonly string[]): string {
  const scrubbed = secretValues.length ? redactSecrets(text, secretValues) : text;
  return cap(scrubbed, LOG_LINE_MAX);
}

/**
 * Redact a failing tool call's arguments before they are persisted. Delegates to the trace payload
 * redactor (sensitive-key masking runs even with no known secret values), so the failure surface is held to
 * the same boundary as the trace it sits beside.
 */
export function redactToolArgs(
  args: Record<string, unknown>,
  secretValues: readonly string[],
): Record<string, unknown> {
  return redactTracePayload(args, secretValues);
}
