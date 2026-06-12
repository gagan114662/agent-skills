import { isProtectedPath } from "./guardrails.js";
import type { ReviewAssessment, RubricCheck } from "./types.js";

/**
 * The pure house-rubric reviewer (#172). This is the spine of the auto-review: given a PR's diff it
 * produces a binary PASS/FAIL plus per-check evidence — exactly the rubric the owner has been applying
 * by hand (gates intact, tenant scoping, migrations numbered by issue, tests present, no secrets). The
 * production reviewer wraps this with a model session for prose judgment; the default (no-credential)
 * reviewer IS this function, so the loop runs deterministically in CI with zero spend.
 *
 * Every check is a total predicate over the structured `RubricInput`, so the reviewer can never throw
 * on hostile diff content and the verdict is fully reproducible (and unit-tested).
 */

/** The structured diff a reviewer judges — paths, change volume, and the added (`+`) lines to scan. */
export interface RubricInput {
  /** The issue number the PR closes (migrations must be numbered with it). */
  issueNumber: number;
  /** Every file path the diff touches. */
  files: string[];
  /** Every added (`+`) line across the diff — what secret/scaffolding scans read. */
  addedLines: string[];
  /** The protected-path patterns (gates/policy/billing/secrets) the rubric flags. */
  protectedPaths: readonly string[];
}

/** Secret-shaped tokens that must never appear in an added line (the "no secrets in code" rail). */
const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "openai_key", re: /sk-[A-Za-z0-9]{16,}/ },
  { id: "aws_key", re: /AKIA[0-9A-Z]{12,}/ },
  { id: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "bearer", re: /bearer\s+[A-Za-z0-9._-]{20,}/i },
  // an assignment of a long opaque literal to a secret-looking key (token/password/secret/apikey)
  { id: "hardcoded_secret", re: /(secret|password|passwd|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i },
];

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)(\/|s\/|-)|\.(test|spec)\.[tj]sx?$/i;
const MIGRATION_PATH = /(^|\/)(drizzle|migrations)\//i;
const MIGRATION_FILE = /(^|\/)(\d{4})_[^/]+\.(sql|ts)$/i;
const CREATE_TABLE = /create\s+table/i;
const WORKSPACE_SCOPED = /workspace_id|workspaceId/i;

/** True when a path is a code file (excludes docs/markdown) — tests are only "required" for code diffs. */
function isCodeFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx)$/i.test(path) && !TEST_PATH.test(path);
}

function check(id: RubricCheck["id"], ok: boolean, detail: string): RubricCheck {
  return { id, ok, detail };
}

/** `tests_present`: a code change must ship test coverage (a docs/migration-only diff is exempt). */
function checkTests(input: RubricInput): RubricCheck {
  const touchesCode = input.files.some(isCodeFile);
  const touchesTests = input.files.some((f) => TEST_PATH.test(f));
  if (!touchesCode) return check("tests_present", true, "no code files changed — tests not required");
  return touchesTests
    ? check("tests_present", true, "diff includes test files")
    : check("tests_present", false, "code changed but no test file is touched");
}

/** `migrations_numbered`: every migration file must be numbered with the issue number (the #99 rule). */
function checkMigrations(input: RubricInput): RubricCheck {
  const migrations = input.files.filter((f) => MIGRATION_PATH.test(f) && MIGRATION_FILE.test(f));
  if (migrations.length === 0) return check("migrations_numbered", true, "no migrations in this diff");
  const want = String(input.issueNumber).padStart(4, "0");
  const offenders = migrations.filter((f) => {
    const m = f.match(MIGRATION_FILE);
    return !m || m[2] !== want;
  });
  return offenders.length === 0
    ? check("migrations_numbered", true, `migration(s) numbered ${want}_*`)
    : check("migrations_numbered", false, `migration not numbered ${want}_*: ${offenders.join(", ")}`);
}

/** `tenant_scoping`: a newly created table must reference `workspace_id` (the #3 tenant boundary). */
function checkTenantScoping(input: RubricInput): RubricCheck {
  const createsTable = input.addedLines.some((l) => CREATE_TABLE.test(l));
  if (!createsTable) return check("tenant_scoping", true, "no new table created");
  const scoped = input.addedLines.some((l) => WORKSPACE_SCOPED.test(l));
  return scoped
    ? check("tenant_scoping", true, "new table references workspace_id")
    : check("tenant_scoping", false, "new table is not workspace-scoped (no workspace_id)");
}

/** `no_secrets`: no added line may match a secret-shaped token. */
function checkNoSecrets(input: RubricInput): RubricCheck {
  for (const line of input.addedLines) {
    for (const { id, re } of SECRET_PATTERNS) {
      if (re.test(line)) return check("no_secrets", false, `possible secret (${id}) in an added line`);
    }
  }
  return check("no_secrets", true, "no secret-shaped tokens in added lines");
}

/** `gates_intact`: a PR that edits a protected gate/policy/billing/secrets path needs a human. */
function checkGatesIntact(input: RubricInput): RubricCheck {
  const touched = input.files.filter((f) => isProtectedPath(f, input.protectedPaths));
  return touched.length === 0
    ? check("gates_intact", true, "no protected gate/policy/billing/secrets path touched")
    : check("gates_intact", false, `protected path(s) touched (human review): ${touched.join(", ")}`);
}

/**
 * Run the full house rubric over a PR diff. PASS iff every check is `ok`. The order of `checks` is the
 * stable rubric order so the rendered verdict comment is deterministic.
 */
export function evaluateHouseRubric(input: RubricInput): ReviewAssessment {
  const checks: RubricCheck[] = [
    checkTests(input),
    checkMigrations(input),
    checkTenantScoping(input),
    checkNoSecrets(input),
    checkGatesIntact(input),
  ];
  const failed = checks.filter((c) => !c.ok);
  const verdict = failed.length === 0 ? "pass" : "fail";
  const summary =
    verdict === "pass"
      ? "All house-rubric checks passed."
      : `${failed.length} rubric check(s) failed: ${failed.map((c) => c.id).join(", ")}.`;
  return { verdict, summary, checks };
}
