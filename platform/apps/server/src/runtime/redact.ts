/**
 * Secret redaction (issue #25 boundary: "secrets never persisted in snapshots or logs").
 *
 * Secrets are injected into a runtime as env at provision time, but their *values* can leak
 * back out through an agent's stdout/stderr (e.g. a harness echoing its environment). Before any
 * output is logged or streamed into a channel, we scrub every known secret value, replacing it
 * with a fixed mask. We never log the secret map itself.
 */

export const REDACTION_MASK = "‹redacted›";

/** Minimum length for a secret value to be worth redacting (avoids masking trivial values). */
const MIN_SECRET_LEN = 4;

const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:API[-_]?KEY|ACCESS[-_]?TOKEN|REFRESH[-_]?TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[-_]?KEY|CLIENT[-_]?SECRET|SESSION[-_]?TOKEN)[A-Z0-9_]*)\s*[:=]\s*([^\s"',;]+)/gi;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\bwhsec_[A-Za-z0-9_]{8,}\b/g,
  /\bSG\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every occurrence of any secret value in `text` with {@link REDACTION_MASK}.
 * Longer secrets are replaced first so a secret that contains another isn't partially masked.
 */
export function redactSecrets(text: string, secretValues: Iterable<string>): string {
  const values = [...secretValues]
    .filter((v) => v.length >= MIN_SECRET_LEN)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTION_MASK);
  }
  return redactPotentialSecrets(out);
}

/**
 * Defense-in-depth redaction for values we were not explicitly handed, such as a user pasting
 * OPENAI_API_KEY=... into a task or an SDK echoing a provider-shaped token into output.
 */
export function redactPotentialSecrets(text: string): string {
  let out = text.replace(SECRET_ASSIGNMENT_RE, (_match, key: string) => key + "=" + REDACTION_MASK);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTION_MASK);
  }
  return out;
}

/** Build a redactor bound to a fixed set of secret values (used per session). */
export function makeRedactor(secrets: Record<string, string>): (text: string) => string {
  const values = Object.values(secrets);
  if (values.length === 0) return (text) => text;
  return (text) => redactSecrets(text, values);
}
