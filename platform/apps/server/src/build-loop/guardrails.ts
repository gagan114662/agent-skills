/**
 * Pure guardrail predicates for the Self-Shipping Loop (#172), mirroring `flywheel/guards.ts`. No IO —
 * `decide.ts` composes these and the engine reuses them to bound auto-merge. The merge guardrails (the
 * core safety contract) all reduce to these total functions so they can be exhaustively unit-tested.
 */

/**
 * The default protected-path list: any PR touching one of these requires a human (never auto-merge).
 * It is the structural expression of "approval gates intact": the policy/approval engine, billing/
 * revenue rails, secret handling, the config merge layers, the kill switch, and the DB migrations that
 * change the shape of those systems. Patterns support a leading double-star segment (suffix match) and a
 * trailing double-star segment (prefix match) plus a single-star wildcard segment — a deliberately small matcher (no deps).
 */
export const DEFAULT_PROTECTED_PATHS = [
  "**/approvals/**",
  "**/billing/**",
  "**/config/layers.ts",
  "**/auth/**",
  "**/crypto/**",
  "**/secrets/**",
  "**/autonomy/guards.ts",
  "**/maintenance/**",
  "**/*secret*",
  "**/*credential*",
] as const;

/**
 * Match one POSIX-ish path against one glob pattern. Supports `**` (any path span, including `/`), `*`
 * (any run of non-`/` chars), and literal segments. Total + allocation-light: a malformed pattern can
 * never throw — it simply fails to match. Case-sensitive (paths are).
 */
export function matchesGlob(path: string, pattern: string): boolean {
  // Build a single anchored regex from the glob. `**` → `.*`; `*` → `[^/]*`; everything else literal.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++; // consume the second star
        // swallow a `/` immediately after `**` so `a/**/b` also matches `a/b`
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".includes(ch ?? "")) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  re += "$";
  try {
    return new RegExp(re).test(path);
  } catch {
    return false;
  }
}

/** True when `path` matches ANY of the protected patterns (the human-review trigger). */
export function isProtectedPath(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

/** The protected files a diff touches (for the escalation evidence), or [] when none. */
export function protectedPathsTouched(files: readonly string[], patterns: readonly string[]): string[] {
  return files.filter((f) => isProtectedPath(f, patterns));
}

/** True while the diff is within BOTH the file-count and line-count caps (0 = no cap on that axis). */
export function diffWithinSizeCap(
  fileCount: number,
  changedLines: number,
  maxFiles: number,
  maxLines: number,
): boolean {
  if (maxFiles > 0 && fileCount > maxFiles) return false;
  if (maxLines > 0 && changedLines > maxLines) return false;
  return true;
}

/** True while there is headroom under the hard concurrent-build cap (0 = never dispatch). */
export function buildCapacityAvailable(inFlight: number, maxConcurrentBuilds: number): boolean {
  return maxConcurrentBuilds > 0 && inFlight < maxConcurrentBuilds;
}

/** True once a run has exhausted its reviewer rounds (a further FAIL must escalate, not revise). */
export function reviewRoundsExhausted(reviewRounds: number, maxReviewRounds: number): boolean {
  return reviewRounds >= maxReviewRounds;
}
