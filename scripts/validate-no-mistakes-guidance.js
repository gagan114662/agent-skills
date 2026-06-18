#!/usr/bin/env node
/**
 * validate-no-mistakes-guidance.js
 *
 * Guards the `no-mistakes` adoption guidance (issue #350, mirrors the lavish-axi
 * #344 precedent). The guidance is OPT-IN/advisory for a THIRD-PARTY tool, so the
 * test enforces two things CI must never let drift:
 *
 *   1. Safety rails are present in every guidance surface (DEFAULT-OFF/opt-in,
 *      owner-gated install, the #13 owner-approval gate, injection-defense
 *      "untrusted DATA", and the third-party trust note).
 *   2. NO FABRICATED COMMANDS. Every `no-mistakes ...` command string that appears
 *      in our docs (inside code spans/blocks) must come from the verified
 *      allow-list below — checked against the project README + its shipped
 *      skills/no-mistakes/SKILL.md. We do not invent commands the tool lacks.
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
// The ONLY `no-mistakes` subcommands the tool actually has, verified against
// https://github.com/kunchenguid/no-mistakes (README + skills/no-mistakes/SKILL.md).
// A bare-word token immediately after `no-mistakes` in a command MUST be one of these.
const VERIFIED_SUBCOMMANDS = new Set(['init', 'axi']);
// `axi` takes exactly these verbs.
const VERIFIED_AXI_VERBS   = new Set(['run', 'respond']);

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
  'docs/no-mistakes.md',
  'platform/docs/adrs/0350-no-mistakes-git-gate.md',
  'scripts/validate-no-mistakes-guidance.js',
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
  ownerGate: ['owner-gated', 'owner gated', 'owner-controlled', 'owner approval', 'owner-approval'],
  gate13:    ['#13'],
  injection: ['untrusted data', 'data, not instructions', 'not instructions'],
  thirdParty:['third-party', 'third party', 'someone else'],
};
const GUIDANCE_SURFACES = [
  { file: 'docs/no-mistakes.md',                            rails: Object.keys(RAIL) },
  { file: 'AGENTS.md',                                      rails: Object.keys(RAIL) },
  { file: 'CLAUDE.md',                                      rails: Object.keys(RAIL) },
  { file: 'skills/git-workflow-and-versioning/SKILL.md',   rails: ['optIn', 'defaultOff', 'ownerGate', 'injection'] },
  { file: 'skills/shipping-and-launch/SKILL.md',           rails: ['optIn', 'defaultOff', 'ownerGate'] },
];

for (const { file, rails } of GUIDANCE_SURFACES) {
  if (!exists(file)) { fail(`MISSING guidance surface: ${file}`); continue; }
  const lc = read(file).toLowerCase();
  if (!lc.includes('no-mistakes')) { fail(`${file}: no \`no-mistakes\` guidance found`); continue; }
  for (const rail of rails) {
    const spellings = RAIL[rail];
    if (spellings.some((s) => lc.includes(s))) ok(`${file}: rail "${rail}" present`);
    else fail(`${file}: MISSING safety rail "${rail}" (one of: ${spellings.join(' | ')})`);
  }
}

// ─── Anti-fabrication: scan command context only ──────────────────────────────
// Pull out fenced code blocks AND inline code spans, so prose like "the
// no-mistakes gate" never trips the check — only real command strings do.
function codeFragments(src) {
  const frags = [];
  const fenced = src.replace(/```([\s\S]*?)```/g, (_, body) => { frags.push(body); return ''; });
  const inlineRe = /`([^`\n]+)`/g;
  let m;
  while ((m = inlineRe.exec(fenced)) !== null) frags.push(m[1]);
  return frags;
}

// In a command context, the token right after `no-mistakes` must be:
//   - a verified subcommand (init|axi), OR
//   - a flag (-y, --yes, ...), OR a placeholder (<branch>, <task>), OR a shell
//     comment (#...) which means the command was bare (TUI). Anything else that is
//     a plain word is an INVENTED command and fails.
const CMD_RE = /\bno-mistakes\s+([^\s`]+)(?:\s+([^\s`]+))?/g;

for (const file of ['docs/no-mistakes.md', 'AGENTS.md', 'CLAUDE.md',
                    'skills/git-workflow-and-versioning/SKILL.md',
                    'skills/shipping-and-launch/SKILL.md']) {
  if (!exists(file)) continue;
  let commandsSeen = 0;
  for (const frag of codeFragments(read(file))) {
    let m;
    CMD_RE.lastIndex = 0;
    while ((m = CMD_RE.exec(frag)) !== null) {
      const tok = m[1];
      // Flags, placeholders, comments → bare/ok.
      if (tok.startsWith('-') || tok.startsWith('<') || tok.startsWith('#')) continue;
      commandsSeen++;
      if (!VERIFIED_SUBCOMMANDS.has(tok)) {
        fail(`${file}: FABRICATED command "no-mistakes ${tok}" — not in verified surface (${[...VERIFIED_SUBCOMMANDS].join(', ')})`);
        continue;
      }
      if (tok === 'axi') {
        const verb = (m[2] || '').replace(/[^a-z]/gi, '');
        if (verb && !VERIFIED_AXI_VERBS.has(verb)) {
          fail(`${file}: FABRICATED "no-mistakes axi ${verb}" — verbs are ${[...VERIFIED_AXI_VERBS].join(', ')}`);
        }
      }
    }
  }
  ok(`${file}: ${commandsSeen} no-mistakes command(s) all verified`);
}

// ─── Relative markdown links resolve ──────────────────────────────────────────
const LINK_RE = /\]\(([^)]+)\)/g;
for (const file of ['docs/no-mistakes.md', 'AGENTS.md', 'CLAUDE.md']) {
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
  console.error(`\n✗ no-mistakes guidance validation FAILED (${errors.length} error(s)):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`✓ no-mistakes guidance valid — ${checks.length} checks passed.`);
process.exit(0);
