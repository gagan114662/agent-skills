#!/usr/bin/env node
/**
 * check-skill-colocation.mjs (#155, ADR-0155 §5)
 *
 * The anti-drift latch from Anthropic's self-service analytics playbook: skills must be maintained as code,
 * colocated with the data model they describe. This check fails a PR that changes a **metric surface** — a
 * governed scorer or a migration touching a governed table — WITHOUT a paired change under
 * `platform/agents/skills/` or `platform/agents/evals/`. The rule: if you move what a number means, you move
 * the skills + evals that teach the fleet about it, in the same PR.
 *
 * Diff source: `git diff --name-only <base>...HEAD`, where <base> is GITHUB_BASE_REF (PR) or origin/main.
 * Dependency-free; runs in the `quality` job next to check-demo-refs.mjs.
 *
 * Exit codes: 0 = colocated (or no metric surface touched), 1 = a metric surface changed without skills.
 */

'use strict';

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The script runs from `platform/` (CI working-directory); resolve repo-relative paths to disk from there.
const REPO_ROOT = path.resolve(process.cwd(), '..');

/** Governed metric-surface files: the pure scorers + the semantic catalog. Repo-relative (under platform/). */
const METRIC_SOURCE_FILES = [
  'apps/server/src/growth/score.ts',
  'apps/server/src/demand/signals.ts',
  'apps/server/src/venture/rubric.ts',
  'apps/server/src/moat/score.ts',
  'apps/server/src/scale/usage.ts',
  'apps/server/src/semantic/catalog.ts',
];

/** The governed metric-surface table prefixes/names. */
const GOVERNED_TABLE_RE = /\b(growth_|demand_|venture_|moat_|eval_runs|tenant_usage)\w*/i;

/**
 * A migration touches a metric surface only when it **creates or alters** a governed table — the rule's
 * documented intent (line 8): "if you move what a number means, you move the skills." A migration that
 * merely **references** a governed table by foreign key (e.g. `... REFERENCES venture_ideas(id)` while
 * creating its own unrelated table) does NOT change that number's meaning and must not trip the gate —
 * that earlier substring match was a false positive (it fired on every PR with a `venture_ideas` FK,
 * e.g. #190 support-desk, #194 finance). Anchoring to the CREATE/ALTER TABLE DDL keeps the real gate
 * (a migration that defines/changes a governed table still trips) while clearing FK references.
 */
const GOVERNED_DDL_RE =
  /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(?:growth_|demand_|venture_|moat_|eval_runs|tenant_usage)\w*/i;

/** A change colocated with skills/evals satisfies the rule. */
const SKILL_PATH_RE = /^platform\/agents\/(skills|evals)\//;

function changedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : 'origin/main';
  // Diff against the merge-base of the PR branch and its target (NOT a shallow tip — a `--depth=1`
  // fetch destroys the merge-base). CI checkout must use fetch-depth: 0 for the base ref to resolve.
  let base = baseRef;
  try {
    base = execSync(`git merge-base ${baseRef} HEAD`, { encoding: 'utf8' }).trim() || baseRef;
  } catch {
    /* no merge-base reachable — fall back to the ref tip (best-effort local run) */
  }
  const out = execSync(`git diff --name-only ${base} HEAD`, { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function isMetricSurface(file) {
  // Repo-relative path is `platform/apps/server/...`; the source list is relative to `platform/`.
  const rel = file.replace(/^platform\//, '');
  if (METRIC_SOURCE_FILES.includes(rel)) return true;
  // A migration (under platform/apps/server/drizzle) that names a governed table. Read the file from the
  // working tree (it reflects the PR HEAD on a CI checkout) — `git show HEAD:<file>` fails on a brand-new
  // or still-uncommitted migration, exactly the case we most need to catch.
  if (/^apps\/server\/drizzle\/.*\.sql$/.test(rel) && !rel.endsWith('.down.sql')) {
    const onDisk = path.join(REPO_ROOT, file);
    // Match a CREATE/ALTER of a governed table (the intent), NOT a mere FK reference to one.
    if (existsSync(onDisk)) return GOVERNED_DDL_RE.test(readFileSync(onDisk, 'utf8'));
    return GOVERNED_TABLE_RE.test(rel); // file was deleted in this PR — fall back to the filename
  }
  return false;
}

function main() {
  const files = changedFiles();
  if (files.length === 0) {
    console.log('check-skill-colocation: no changed files vs base — OK');
    return;
  }
  const metricSurfaces = files.filter(isMetricSurface);
  const touchedSkills = files.some((f) => SKILL_PATH_RE.test(f));

  if (metricSurfaces.length === 0) {
    console.log('check-skill-colocation: no metric surface changed — OK');
    return;
  }
  if (touchedSkills) {
    console.log(
      `check-skill-colocation: metric surface(s) changed and skills/evals updated alongside — OK\n  surfaces: ${metricSurfaces.join(', ')}`,
    );
    return;
  }

  console.error(
    'check-skill-colocation: a metric surface changed WITHOUT a paired skill/eval update (#155).\n' +
      `  changed metric surfaces:\n    - ${metricSurfaces.join('\n    - ')}\n` +
      '  Fix: update the relevant agent skill (platform/agents/skills/<agent>/) and/or its eval suite\n' +
      '  (platform/agents/evals/<agent>.json) in THIS PR so the fleet learns the new definition.\n' +
      "  Skills drift (95% → 65% accuracy in a month) when they aren't maintained with the data model.",
  );
  process.exit(1);
}

main();
