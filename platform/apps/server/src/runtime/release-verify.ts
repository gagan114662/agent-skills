/**
 * Release version-advance verification (#292) — prove the running prod release is the one we just shipped.
 *
 * The #292 prod blocker: `reload-api` stayed on VERSION 80 while CI was green, so the merged #247 model
 * fix never reached users and the console kept throwing "model isn't available". The cause was a blind
 * spot in the deploy gate: it verified `/readyz` (Postgres + Redis reachable), which the OLD v80 release
 * also passes — there was nothing that confirmed the *running image actually changed*. A deploy that
 * silently no-ops (the `paths:` filter not matching, the unset-`FLY_API_TOKEN` guard skipping cleanly, or
 * a release that never cut over) therefore reported success while prod stayed stuck.
 *
 * This module is the missing externally-verified receipt (premortem #200, FM#2 — "verification that never
 * touches reality"): we stamp the build's git SHA into the image (`GIT_SHA`, served at `GET /version`) and,
 * after a deploy, probe the LIVE host and assert its reported SHA matches the commit we just pushed. The
 * decision is pure and FAIL-CLOSED — an empty/unknown/malformed SHA on either side is "NOT advanced",
 * never a fabricated pass.
 *
 * Injection defense (premortem #200, FM#6): the live `/version` body is UNTRUSTED data fetched over the
 * network. {@link normalizeSha} treats it as such — it only accepts a bounded hex string and lower-cases
 * it; anything else (HTML error page, attacker-controlled JSON, oversized blob) normalizes to `null` and
 * fails the gate closed. No reported value is ever interpreted, logged unbounded, or trusted beyond an
 * equality/prefix comparison.
 */

/**
 * A git object SHA: 7–64 lowercase hex chars. Git's default abbreviation is 7 (collision-safe for repos
 * of this size) and a full sha-1 is 40; the 64 ceiling forward-accommodates sha-256 object names. The
 * bound is also the injection guard — a `/version` response that isn't a plain short hex string can never
 * masquerade as a matching release.
 */
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Coerce an untrusted value into a canonical git SHA, or `null` when it is not one.
 * Trims surrounding whitespace and lower-cases before validating, so `"  ABC1234\n"` ⇒ `"abc1234"`.
 */
export function normalizeSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

export interface ReleaseAdvanceVerdict {
  /** True ONLY when both SHAs are valid and one is a prefix of the other (same commit). */
  advanced: boolean;
  /** Secret-free, human-readable outcome line for CI logs. */
  reason: string;
  /** The normalized expected SHA (the commit we deployed), or `null` when not a valid SHA. */
  expected: string | null;
  /** The normalized live SHA reported by the running host, or `null` when missing/malformed. */
  live: string | null;
}

/**
 * Decide whether the live release advanced to the expected commit. Pure and fail-closed:
 *  - a missing/malformed *expected* SHA → not advanced (we cannot make a claim we can't ground);
 *  - a missing/malformed/empty *live* SHA → not advanced (the classic #292 "still on the old image",
 *    or a `/version` that returned `""` because the running image predates the build stamp);
 *  - otherwise advanced IFF one SHA is a prefix of the other (either side may be abbreviated).
 */
export function decideReleaseAdvanced(input: {
  expectedSha: unknown;
  liveSha: unknown;
}): ReleaseAdvanceVerdict {
  const expected = normalizeSha(input.expectedSha);
  const live = normalizeSha(input.liveSha);

  if (!expected) {
    return {
      advanced: false,
      reason:
        "no valid expected SHA to verify against (set RELEASE_EXPECTED_SHA to the deployed commit, " +
        "e.g. GITHUB_SHA). Refusing to claim a release advanced without a target.",
      expected,
      live,
    };
  }
  if (!live) {
    return {
      advanced: false,
      reason:
        `the running host did not report a valid build SHA — it is most likely still serving the ` +
        `PREVIOUS release (the #292 "stuck on the old version" failure), or the running image predates ` +
        `the /version build stamp. Expected ${expected}.`,
      expected,
      live,
    };
  }

  const advanced = expected.startsWith(live) || live.startsWith(expected);
  return {
    advanced,
    reason: advanced
      ? `release advanced: the live host reports ${live}, matching the deployed commit ${expected}.`
      : `release did NOT advance: the live host reports ${live} but the deployed commit is ${expected}. ` +
        `Prod is still running a different image (the #292 failure) — the deploy did not cut over.`,
    expected,
    live,
  };
}
