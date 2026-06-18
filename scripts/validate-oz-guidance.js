#!/usr/bin/env node
/**
 * validate-oz-guidance.js
 *
 * Guards the `oz-loops` adoption guidance (issue #356, mirrors the lavish-axi #344 / no-mistakes #350
 * precedents). We adopt the open-source PATTERNS of warpdotdev/oz-for-oss (MIT) as gated fleet loops, so the
 * test enforces three things CI must never let drift:
 *
 *   1. Safety rails are present in every guidance surface (DEFAULT-OFF/opt-in, owner-gated, the #13
 *      owner-approval gate, injection-defense "untrusted DATA", and the third-party trust note).
 *   2. NO FABRICATED OZ-FOR-OSS SKILLS. Every oz-for-oss skill name cited inside the verified block of
 *      docs/oz-loops.md (between the `oz-skills:start`/`oz-skills:end` markers) must be in the allow-list
 *      below — checked against the project's `.agents/skills/` directory. We do not invent skills it lacks.
 *   3. The four loop names triage/spec/review/pr-comment are all documented.
 *
 * Plus: required files exist, and relative markdown links resolve.
 *
 * Exit codes: 0 = all clear, 1 = one or more errors.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── Verified surface ─────────────────────────────────────────────────────────
// The oz-for-oss skills we are allowed to cite, verified against
// https://github.com/warpdotdev/oz-for-oss/tree/main/.agents/skills (the real directory listing).
const VERIFIED_OZ_SKILLS = new Set([
  'bootstrap-issue-config',
  'create-product-spec',
  'create-tech-spec',
  'dedupe-issue-local',
  'dedupe-issue',
  'implement-issue',
  'review-pr-local',
  'review-spec-local',
  'review-spec',
  'security-review-pr',
  'security-review-spec',
  'triage-issue-local',
  'triage-issue',
  'update-dedupe',
  'update-pr-review',
  'update-triage',
  'verify-pr',
]);

const errors = [];
const checks = [];
const ok   = (m) => checks.push(m);
const fail = (m) => errors.push(m);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

// Files that must exist.
const REQUIRED_FILES = [
  'docs/oz-loops.md',
  'platform/docs/adrs/0356-oz-loops-engineering-loops.md',
  'scripts/validate-oz-guidance.js',
];
for (const f of REQUIRED_FILES) {
  if (exists(f)) ok(`exists: ${f}`);
  else fail(`MISSING required file: ${f}`);
}

// Guidance surfaces and the rail phrases each must carry. Each phrase entry is an array of acceptable
// spellings — any one match satisfies it (case-insensitive).
const RAIL = {
  optIn:     ['opt-in', 'opt in'],
  defaultOff:['default-off', 'default off'],
  ownerGate: ['owner-gated', 'owner gated', 'owner-controlled', 'owner approval', 'owner-approval', 'owner-workspace-first', 'owner workspace'],
  gate13:    ['#13'],
  injection: ['untrusted data', 'data, not instructions', 'not instructions', 'never instructions'],
  thirdParty:['third-party', 'third party', 'warp'],
};
const GUIDANCE_SURFACES = [
  { file: 'docs/oz-loops.md', rails: Object.keys(RAIL) },
  { file: 'AGENTS.md',        rails: Object.keys(RAIL) },
  { file: 'CLAUDE.md',        rails: Object.keys(RAIL) },
];

for (const { file, rails } of GUIDANCE_SURFACES) {
  if (!exists(file)) { fail(`MISSING guidance surface: ${file}`); continue; }
  const lc = read(file).toLowerCase();
  if (!lc.includes('oz-loops') && !lc.includes('oz-for-oss')) {
    fail(`${file}: no oz-loops guidance found`);
    continue;
  }
  for (const rail of rails) {
    const spellings = RAIL[rail];
    if (spellings.some((s) => lc.includes(s))) ok(`${file}: rail "${rail}" present`);
    else fail(`${file}: MISSING safety rail "${rail}" (one of: ${spellings.join(' | ')})`);
  }
}

// The four loops must all be named in the reference doc.
if (exists('docs/oz-loops.md')) {
  const lc = read('docs/oz-loops.md').toLowerCase();
  for (const loop of ['triage', 'spec', 'review', 'pr-comment']) {
    if (lc.includes(loop)) ok(`docs/oz-loops.md: loop "${loop}" documented`);
    else fail(`docs/oz-loops.md: MISSING loop "${loop}"`);
  }
}

// ─── Anti-fabrication: only verified oz-for-oss skills in the marked block ─────
if (exists('docs/oz-loops.md')) {
  const src = read('docs/oz-loops.md');
  const block = /<!--\s*oz-skills:start\s*-->([\s\S]*?)<!--\s*oz-skills:end\s*-->/.exec(src);
  if (!block) {
    fail('docs/oz-loops.md: missing the `oz-skills:start`/`oz-skills:end` verified-skills block');
  } else {
    const cited = [];
    const inlineRe = /`([^`\n]+)`/g;
    let m;
    while ((m = inlineRe.exec(block[1])) !== null) cited.push(m[1].trim());
    if (cited.length === 0) fail('docs/oz-loops.md: verified-skills block cites no skills');
    for (const name of cited) {
      if (VERIFIED_OZ_SKILLS.has(name)) ok(`oz skill verified: ${name}`);
      else fail(`docs/oz-loops.md: FABRICATED oz-for-oss skill "${name}" — not in the verified .agents/skills set`);
    }
  }
}

// ─── Relative markdown links resolve ──────────────────────────────────────────
const LINK_RE = /\]\(([^)]+)\)/g;
for (const file of ['docs/oz-loops.md', 'AGENTS.md', 'CLAUDE.md']) {
  if (!exists(file)) continue;
  const src = read(file);
  const dir = path.dirname(path.join(ROOT, file));
  let m, broken = 0;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(src)) !== null) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;      // external / anchor-only
    target = target.split('#')[0];                          // drop in-page anchor
    if (!target) continue;
    if (!fs.existsSync(path.resolve(dir, target))) {
      fail(`${file}: broken relative link -> ${m[1]}`);
      broken++;
    }
  }
  if (!broken) ok(`${file}: all relative links resolve`);
}

// ─── Report ───────────────────────────────────────────────────────────────────
if (process.env.VERBOSE) for (const c of checks) console.log(`  ok  ${c}`);

if (errors.length) {
  console.error(`\n✗ oz-loops guidance validation FAILED (${errors.length} error(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ oz-loops guidance valid — ${checks.length} checks passed.`);
process.exit(0);
