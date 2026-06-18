#!/usr/bin/env node
/**
 * validate-open-design-guidance.js
 *
 * Guards the `open-design` adoption guidance (issue #353, mirrors the lavish-axi
 * #344 and no-mistakes #350 precedents). The guidance is OPT-IN/advisory for a
 * THIRD-PARTY, heavyweight desktop app, so the test enforces two things CI must
 * never let drift:
 *
 *   1. Safety rails are present in every guidance surface (DEFAULT-OFF/opt-in,
 *      owner-gated/owner-first, the #13 owner-approval gate, injection-defense
 *      "untrusted DATA", and the third-party / heavyweight trust note).
 *   2. NO FABRICATED COMMANDS. Every `od ...` command string and the install
 *      one-liner that appear in our docs (inside code spans/blocks) must come from
 *      the verified allow-list below — checked against the project README
 *      (https://github.com/nexu-io/open-design). We do not invent commands the tool
 *      lacks.
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
// The ONLY `od` subcommands the tool actually has, verified against
// https://github.com/nexu-io/open-design (README). A bare-word token immediately
// after `od` in a command MUST be one of these.
const VERIFIED_OD_SUBCOMMANDS = new Set([
  'mcp', 'plugin', 'skill', 'get-file', 'get-artifact', 'search-files',
]);
// Verbs for the subcommands that take one.
const VERIFIED_VERBS = {
  mcp:    new Set(['install']),
  plugin: new Set(['list', 'search', 'info', 'install', 'apply', 'upgrade', 'uninstall', 'scaffold', 'validate']),
  skill:  new Set(['list']),
};
// The verified install host (the only install one-liner the README documents).
const VERIFIED_INSTALL_HOST = 'open-design.ai/install.sh';

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
  'docs/open-design.md',
  'platform/docs/adrs/0353-open-design-brand-assets.md',
  'scripts/validate-open-design-guidance.js',
  'platform/apps/server/src/open-design/caps.ts',
];
for (const f of REQUIRED_FILES) {
  if (exists(f)) ok(`exists: ${f}`);
  else fail(`MISSING required file: ${f}`);
}

// Guidance surfaces and the rail phrases each must carry. Each phrase entry is an
// array of acceptable spellings — any one match satisfies it (case-insensitive).
const RAIL = {
  optIn:     ['opt-in', 'opt in'],
  defaultOff:['default-off', 'default off'],
  ownerGate: ['owner-gated', 'owner gated', 'owner-controlled', 'owner approval', 'owner-approval', 'owner-workspace-first', 'owner-first'],
  gate13:    ['#13'],
  injection: ['untrusted data', 'data, not instructions', 'not instructions'],
  thirdParty:['third-party', 'third party', 'heavyweight', 'someone else'],
};
const GUIDANCE_SURFACES = [
  { file: 'docs/open-design.md',                          rails: Object.keys(RAIL) },
  { file: 'AGENTS.md',                                    rails: Object.keys(RAIL) },
  { file: 'CLAUDE.md',                                    rails: Object.keys(RAIL) },
  { file: 'skills/frontend-ui-engineering/SKILL.md',      rails: ['optIn', 'defaultOff', 'ownerGate', 'injection'] },
  { file: 'platform/agents/skills/mark/runbook.md',       rails: ['optIn', 'defaultOff', 'ownerGate', 'injection', 'gate13'] },
];

for (const { file, rails } of GUIDANCE_SURFACES) {
  if (!exists(file)) { fail(`MISSING guidance surface: ${file}`); continue; }
  const lc = read(file).toLowerCase();
  if (!lc.includes('open-design')) { fail(`${file}: no \`open-design\` guidance found`); continue; }
  for (const rail of rails) {
    const spellings = RAIL[rail];
    if (spellings.some((s) => lc.includes(s))) ok(`${file}: rail "${rail}" present`);
    else fail(`${file}: MISSING safety rail "${rail}" (one of: ${spellings.join(' | ')})`);
  }
}

// ─── Anti-fabrication: scan command context only ──────────────────────────────
// Pull out fenced code blocks AND inline code spans, so prose like "the open-design
// app" never trips the check — only real command strings do.
function codeFragments(src) {
  const frags = [];
  const fenced = src.replace(/```([\s\S]*?)```/g, (_, body) => { frags.push(body); return ''; });
  const inlineRe = /`([^`\n]+)`/g;
  let m;
  while ((m = inlineRe.exec(fenced)) !== null) frags.push(m[1]);
  return frags;
}

// In a command context, the token right after `od` must be:
//   - a verified subcommand, OR
//   - a flag (--print, --uninstall, ...), a placeholder (<agent>), or a shell
//     comment (#...). Anything else that is a plain word is an INVENTED command.
const CMD_RE = /\bod\s+([^\s`]+)(?:\s+([^\s`]+))?/g;

const COMMAND_SURFACES = GUIDANCE_SURFACES.map((s) => s.file);
for (const file of COMMAND_SURFACES) {
  if (!exists(file)) continue;
  const src = read(file);
  let commandsSeen = 0;
  for (const frag of codeFragments(src)) {
    let m;
    CMD_RE.lastIndex = 0;
    while ((m = CMD_RE.exec(frag)) !== null) {
      const tok = m[1];
      // Flags, placeholders, comments → bare/ok.
      if (tok.startsWith('-') || tok.startsWith('<') || tok.startsWith('#')) continue;
      commandsSeen++;
      if (!VERIFIED_OD_SUBCOMMANDS.has(tok)) {
        fail(`${file}: FABRICATED command "od ${tok}" — not in verified surface (${[...VERIFIED_OD_SUBCOMMANDS].join(', ')})`);
        continue;
      }
      const verbs = VERIFIED_VERBS[tok];
      if (verbs && m[2]) {
        const verb = m[2];
        // Skip flags/placeholders in the verb slot.
        if (!verb.startsWith('-') && !verb.startsWith('<') && !verb.startsWith('"')) {
          if (!verbs.has(verb)) {
            fail(`${file}: FABRICATED "od ${tok} ${verb}" — verbs are ${[...verbs].join(', ')}`);
          }
        }
      }
    }
    // Any open-design install one-liner must point at the verified host. Scope to
    // open-design install commands only (these use `sh -s <agent>`), so the
    // unrelated no-mistakes / treehouse `curl … install.sh | sh` references in the
    // same files don't trip it.
    if (/install\.sh/.test(frag) && /\bsh\s+-s\b/.test(frag) && !frag.includes(VERIFIED_INSTALL_HOST)) {
      fail(`${file}: FABRICATED open-design install one-liner — must use ${VERIFIED_INSTALL_HOST}`);
    }
  }
  ok(`${file}: ${commandsSeen} od command(s) all verified`);
}

// ─── Relative markdown links resolve ──────────────────────────────────────────
const LINK_RE = /\]\(([^)]+)\)/g;
for (const file of ['docs/open-design.md', 'AGENTS.md', 'CLAUDE.md']) {
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
  console.error(`\n✗ open-design guidance validation FAILED (${errors.length} error(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ open-design guidance valid — ${checks.length} checks passed.`);
process.exit(0);
