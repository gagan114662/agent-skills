/**
 * Up-front Claude key validation (#659).
 *
 * THE failure this prevents: a workspace pastes (or OAuth-connects) a Claude subscription token that is
 * blank-after-paste, mangled (an embedded newline/space from a sloppy copy), or revoked — and nothing
 * notices until a real `claude -p` session is spawned, runs, and exits 1 having produced nothing. The
 * owner sees "error · exit 1" mid-run, work is wasted, and the actual cause (a bad credential) is buried.
 *
 * This module makes a bad key surface AT THE BOUNDARY instead of mid-run, mirroring the model preflight
 * (`runtime/models.ts`): a pure, total, network-free FORMAT check that runs on every entry + at run-start,
 * plus an OPTIONAL, env-gated LIVE check (a zero-spend auth probe) that catches a well-formed-but-revoked
 * key the instant it is entered. The live check is DEFAULT-OFF and FAILS OPEN on any inconclusive answer
 * (rate-limit, network blip, unexpected status), so it can never wrongly block a legitimate key — only a
 * definitive 401/403 rejects.
 *
 * Deliberately lenient on length/charset: the subscription token format is opaque and not ours to assume,
 * so the format check only rejects what is unambiguously broken (empty, internal whitespace, control
 * characters). The teeth for "revoked/invalid" are the live probe; the teeth for "mangled paste" are the
 * format rules. Neither is allowed to reject a plausible token on a guess.
 */

/** The verdict for a single token check. `checkedLive` records whether a network probe actually ran. */
export interface ClaudeKeyCheck {
  valid: boolean;
  /** A short, owner-actionable, credential-free reason when `valid` is false (safe to surface). */
  reason?: string;
  checkedLive: boolean;
}

/**
 * Thrown when a key is rejected at a save boundary that prefers an exception to a verdict object. Mirrors
 * `ModelUnavailableError`: owner-actionable and credential-free (it never embeds the token), so it is safe
 * to map to an HTTP 400 or a channel message — never a generic mid-run crash.
 */
export class ClaudeKeyInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`Claude key invalid: ${reason}`);
    this.name = "ClaudeKeyInvalidError";
  }
}

/** Control characters (incl. newline/tab/NUL) that should never appear inside a pasted credential. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
/** Any inner whitespace — a real OAuth/setup token is a single unbroken string. */
const WHITESPACE_RE = /\s/;

/**
 * Pure, total, network-free format check. Returns a verdict (never throws). Rejects ONLY the
 * unambiguously-broken shapes a bad paste produces; it is intentionally length/charset-lenient so a
 * legitimate opaque token is never second-guessed. Inner whitespace/control chars are caught even when
 * the caller already trimmed the ends.
 */
export function validateClaudeKeyFormat(token: string): ClaudeKeyCheck {
  if (token.trim().length === 0) {
    return { valid: false, reason: "the token is empty", checkedLive: false };
  }
  if (CONTROL_CHARS_RE.test(token)) {
    return {
      valid: false,
      reason: "the token contains line breaks or control characters — re-copy it without extra whitespace",
      checkedLive: false,
    };
  }
  if (WHITESPACE_RE.test(token.trim())) {
    return {
      valid: false,
      reason: "the token contains spaces — re-copy it without extra whitespace",
      checkedLive: false,
    };
  }
  return { valid: true, checkedLive: false };
}

/** Convenience boolean for the run-start path (`decideAgentAuth`): well-formed ⇒ may carry auth. */
export function isWellFormedClaudeKey(token: string): boolean {
  return validateClaudeKeyFormat(token).valid;
}

/** Throw {@link ClaudeKeyInvalidError} on a malformed token; no-op when well-formed (save-path helper). */
export function assertClaudeKeyFormat(token: string): void {
  const result = validateClaudeKeyFormat(token);
  if (!result.valid) throw new ClaudeKeyInvalidError(result.reason ?? "the token is invalid");
}

/**
 * The async validation seam. The default impl is format-only (no network), so CI/dev/fresh-clone stay
 * deterministic and offline; a deployment that wants live revocation catching swaps in the HTTP impl.
 */
export interface ClaudeKeyChecker {
  check(token: string): Promise<ClaudeKeyCheck>;
}

/** Format-only checker — the safe default. Never makes a network call. */
export class FormatOnlyClaudeKeyChecker implements ClaudeKeyChecker {
  async check(token: string): Promise<ClaudeKeyCheck> {
    return validateClaudeKeyFormat(token);
  }
}

/** Minimal fetch shape so the live checker is unit-testable without the global fetch. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>;

/** The zero-spend auth probe endpoint — listing models authenticates without consuming any tokens. */
export const CLAUDE_VALIDATION_ENDPOINT = "https://api.anthropic.com/v1/models";

/**
 * Live checker: a well-formed token is probed against a zero-spend authenticated endpoint. Semantics are
 * deliberately conservative — only a definitive `401`/`403` rejects the key; ANY other outcome (2xx, a
 * 429 rate-limit, a 5xx, or a thrown network error) is treated as "not disproven" and FAILS OPEN, so the
 * probe can never wrongly block a legitimate key on a transient hiccup. Format is checked first so a
 * malformed token never reaches the network.
 */
export class LiveClaudeKeyChecker implements ClaudeKeyChecker {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly endpoint: string = CLAUDE_VALIDATION_ENDPOINT,
    private readonly timeoutMs: number = 5_000,
  ) {}

  async check(token: string): Promise<ClaudeKeyCheck> {
    const format = validateClaudeKeyFormat(token);
    if (!format.valid) return format;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "GET",
        headers: {
          // A subscription `setup-token` authenticates as a Bearer; the version header is required by the API.
          authorization: `Bearer ${token}`,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        return {
          valid: false,
          reason: "the Claude account rejected this token — reconnect your Claude subscription",
          checkedLive: true,
        };
      }
      // Any other status (2xx, 429, 5xx, ...) is inconclusive for revocation → fail open.
      return { valid: true, checkedLive: true };
    } catch {
      // Network error / timeout: never block a legitimate key on infrastructure.
      return { valid: true, checkedLive: true };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether a deployment opted into the live revocation probe (DEFAULT-OFF). */
export function isLiveKeyValidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDE_KEY_VALIDATION ?? "").trim().toLowerCase() === "live";
}

/**
 * Build the checker for a deployment: the live HTTP probe when `CLAUDE_KEY_VALIDATION=live` AND a fetch
 * is available, else the format-only default. Reads env at call time (like `loadGoogleOAuthConfig`), so it
 * needs no app-level wiring — a route can construct it inline.
 */
export function createClaudeKeyChecker(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike | undefined = typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined,
): ClaudeKeyChecker {
  if (isLiveKeyValidationEnabled(env) && fetchImpl) {
    return new LiveClaudeKeyChecker(fetchImpl);
  }
  return new FormatOnlyClaudeKeyChecker();
}
