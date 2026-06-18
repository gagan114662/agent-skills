/**
 * Connect-Claude connection health (#365, ADR-0365).
 *
 * The fleet runs SUBSCRIPTION-ONLY, per tenant (#246, `fly.toml`): a workspace runs real `claude-code`
 * sessions only once it connects its OWN `CLAUDE_CODE_OAUTH_TOKEN` into the #68 vault. Until then every
 * @mention gets the friendly "reconnect your Claude" reply and the board stays empty — so the owner needs
 * to see, at a glance, whether the connection is live. This is the PURE half of that signal: a total,
 * fail-closed derivation of a tri-state health from facts the vault already holds, with NO live network
 * call and NO access to the token itself.
 *
 * The three states the owner sees:
 *   · `not_connected` — no credential in the vault. The fleet cannot run; the owner must connect.
 *   · `connected`     — a credential is present and nothing has observed it failing since.
 *   · `expired`       — a credential is present but a real agent launch OBSERVED it as unusable AFTER the
 *                       last (re)connect (a removed/blanked/undecryptable stored token). "Token expired"
 *                       in owner-facing terms: reconnect to bring the fleet back online.
 *
 * Honoring the premortem (#200):
 *  - §3 production-grounded: `expired` is reported ONLY from an OBSERVED failure (a recorded
 *    `lastAuthFailureAt`), never guessed. We make no live validation call and never inspect the token, so
 *    we can never fake a "valid"/"connected" we didn't verify — a present credential with no observed
 *    failure is honestly `connected`, nothing more. (Detecting a token that still decrypts but is revoked
 *    upstream requires a real run; that is the owner-gated verification step, not a fabricated check here.)
 *  - §4 reversibility: a (re)connect clears the observation (the repo nulls `lastAuthFailureAt`), so the
 *    state flips back to `connected` the moment the owner reconnects — never a sticky false alarm.
 *  - §6 injection defense: inputs are timestamps + a boolean only; there is no string content to interpret,
 *    so this surface cannot be steered by attacker-controlled data.
 */

export type ClaudeConnectionHealth = "not_connected" | "connected" | "expired";

export interface ClaudeConnectionHealthInput {
  /** Whether a credential row exists in the #68 vault for this workspace. */
  connected: boolean;
  /** When the current credential was last (re)connected, or null when not connected. */
  connectedAt: Date | null;
  /**
   * When a real agent launch last OBSERVED the stored credential as unusable, or null when none observed.
   * Only meaningful while `connected` — a disconnect deletes the row (and this marker) entirely.
   */
  lastAuthFailureAt: Date | null;
}

export interface ClaudeConnectionHealthResult {
  state: ClaudeConnectionHealth;
  /** A short, owner-facing, secret-free reason — present only when something needs the owner's attention. */
  reason: string | null;
}

/**
 * Whether an observed auth failure is NEWER than the last (re)connect — i.e. it reflects the credential
 * currently in the vault, not a stale failure from a token the owner has since replaced. A failure with
 * no `connectedAt` to compare against is treated as current (fail-closed: surface the problem). Uses `>=`
 * so a failure stamped in the same instant as the connect still counts (the connect would clear it in
 * practice; this only matters for synthetic equal-timestamp inputs, where surfacing is the safe choice).
 */
function failureIsCurrent(connectedAt: Date | null, lastAuthFailureAt: Date): boolean {
  if (connectedAt === null) return true;
  return lastAuthFailureAt.getTime() >= connectedAt.getTime();
}

/**
 * Derive the connection health. Pure + total + fail-closed: an unconnected workspace is always
 * `not_connected`; a connected workspace is `expired` only when a CURRENT observed failure exists, else
 * `connected`. Never throws and never reads anything but the three facts above.
 */
export function deriveClaudeConnectionHealth(
  input: ClaudeConnectionHealthInput,
): ClaudeConnectionHealthResult {
  if (!input.connected) {
    return {
      state: "not_connected",
      reason:
        "Connect your Claude account so your fleet can run — until then agents reply asking you to connect.",
    };
  }
  if (input.lastAuthFailureAt !== null && failureIsCurrent(input.connectedAt, input.lastAuthFailureAt)) {
    return {
      state: "expired",
      reason:
        "Your connected Claude token stopped working on the last run — reconnect to bring your fleet back online.",
    };
  }
  return { state: "connected", reason: null };
}
