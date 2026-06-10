import type { FailureEvent, FingerprintRecord } from "./types.js";

/**
 * Issue / comment / task rendering for the Self-Healing Flywheel (#117, ADR-0117 §3). **Pure**, and —
 * critically — every render site reads ONLY already-redacted fields (`sampleContext` is redacted at
 * ingest by {@link buildSampleContext}; the title/signature carry no secret). A secret therefore has no
 * path to a GitHub issue body. This is the load-bearing safety invariant (proven by test).
 */

/** The (pre-redaction) evidence bundle shape. Persisted as a REDACTED JSON string on the fingerprint. */
interface SampleBundle {
  source?: string;
  message: string;
  detail?: string;
  traceId?: string;
  sessionId?: string;
}

/**
 * Build the redacted sample context bundle for a failure. The `redact` fn (bound to the event's
 * secret values, #25) scrubs the ENTIRE serialized bundle before it is returned — so secrets are gone
 * before the string is ever persisted, rendered, or logged.
 */
export function buildSampleContext(
  event: Pick<FailureEvent, "source" | "message" | "detail" | "traceId" | "sessionId">,
  redact: (text: string) => string,
): string {
  const bundle: SampleBundle = {
    source: event.source,
    message: event.message,
    detail: event.detail,
    traceId: event.traceId,
    sessionId: event.sessionId,
  };
  return redact(JSON.stringify(bundle));
}

/** Parse a persisted sample bundle back out (best-effort; already redacted). */
function parseSample(sampleContext: string): SampleBundle {
  try {
    return JSON.parse(sampleContext) as SampleBundle;
  } catch {
    return { message: sampleContext };
  }
}

function evidenceBlock(fp: FingerprintRecord): string {
  const s = parseSample(fp.sampleContext);
  const lines = [
    `- **Signature:** \`${fp.signature}\``,
    `- **Class:** \`${fp.failureClass}\``,
    `- **Occurrences:** ${fp.occurrenceCount}`,
    `- **First seen:** ${fp.firstSeenAt.toISOString()}`,
    `- **Last seen:** ${fp.lastSeenAt.toISOString()}`,
  ];
  if (s.traceId) lines.push(`- **Trace id:** \`${s.traceId}\``);
  if (s.source) lines.push(`- **Source:** \`${s.source}\``);
  return lines.join("\n");
}

/** The full issue body for a freshly-drafted fingerprint issue (redacted excerpt + ACs). */
export function renderIssueBody(fp: FingerprintRecord): string {
  const s = parseSample(fp.sampleContext);
  return [
    "> Auto-filed by the Self-Healing Flywheel (#117). Failures are training data.",
    "",
    "## Evidence",
    evidenceBlock(fp),
    "",
    "## Redacted log excerpt",
    "```",
    s.detail ? `${s.message}\n\n${s.detail}` : s.message,
    "```",
    "",
    "## Repro hints",
    `- Reproduce a \`${fp.failureClass}\` failure matching the signature above.`,
    "- The excerpt is redacted (#25) — secrets are masked, never the real values.",
    "",
    "## Acceptance criteria",
    "- [ ] Root cause identified (not just the symptom).",
    "- [ ] Fix lands with a failing-first test that reproduces this signature.",
    "- [ ] The signature does not recur after the fix (the flywheel verifies via #106).",
  ].join("\n");
}

/** A comment posted when an already-open issue accrues more occurrences (never a duplicate issue). */
export function renderRecurrenceComment(fp: FingerprintRecord): string {
  return (
    `🔁 Still happening — now **${fp.occurrenceCount}** occurrences ` +
    `(last seen ${fp.lastSeenAt.toISOString()}). Signature \`${fp.signature}\`.`
  );
}

/** A comment posted when a *fixed* fingerprint recurs and the issue is reopened (escalated). */
export function renderReopenComment(fp: FingerprintRecord): string {
  return (
    `🚨 **Recurrence after fix** — this signature (\`${fp.signature}\`) came back after being marked ` +
    `fixed${fp.fixRef ? ` (\`${fp.fixRef}\`)` : ""}. Reopened with escalated priority and **excluded ` +
    `from auto-dispatch** — a human must review before another fix agent is launched (#106).`
  );
}

/** The task prompt handed to a dispatched fix agent (data, never argv) — redacted evidence only. */
export function renderFixTask(fp: FingerprintRecord): string {
  const s = parseSample(fp.sampleContext);
  return [
    `You are a fix agent dispatched by the Self-Healing Flywheel for a recurring \`${fp.failureClass}\` ` +
      `failure (signature \`${fp.signature}\`, ${fp.occurrenceCount} occurrences).`,
    fp.issueRef ? `Tracking issue: ${fp.issueRef}.` : "",
    "",
    "Redacted evidence:",
    s.detail ? `${s.message}\n${s.detail}` : s.message,
    "",
    "Find the root cause, write a failing-first test that reproduces this signature, then fix it so the " +
      "signature stops recurring. Do not paper over the symptom.",
  ]
    .filter(Boolean)
    .join("\n");
}
