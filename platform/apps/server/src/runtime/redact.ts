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
  return out;
}

/** Build a redactor bound to a fixed set of secret values (used per session). */
export function makeRedactor(secrets: Record<string, string>): (text: string) => string {
  const values = Object.values(secrets);
  if (values.length === 0) return (text) => text;
  return (text) => redactSecrets(text, values);
}
