#!/usr/bin/env node
/**
 * check-demo-refs.mjs
 *
 * Guards the project's Definition-of-Done against false completion claims.
 *
 * The convention (platform/README.md): every PR ships a runnable demo script under
 * `scripts/demos/`, and merged features additionally commit a recorded video under
 * `docs/demos/`. Specs cite those paths as their proof artifacts. This check fails CI
 * when a spec or README cites a `docs/demos/*.mp4` or `scripts/demos/*.{sh,ts}` path
 * that does not exist in the tree — so a "demo `docs/demos/X.mp4`" claim cannot drift
 * away from reality again (the gap that issue #85 found).
 *
 * Scope (per #85: "a spec/README references …"):
 *   - every Markdown file under docs/specs/
 *   - every README.md under platform/ (excluding node_modules)
 *
 * Exit codes: 0 = all referenced demo paths exist, 1 = one or more are missing.
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A reference may be written with or without a leading `platform/` and may be wrapped
// in backticks. Capture the repo-relative `docs/demos/*.mp4` / `scripts/demos/*.{sh,ts}` path.
const DEMO_REF = /(?:platform\/)?(docs\/demos\/[A-Za-z0-9._-]+\.mp4|scripts\/demos\/[A-Za-z0-9._-]+\.(?:sh|ts))/g;

/** Recursively collect files under `dir` matching `predicate`, skipping node_modules. */
function walk(dir, predicate, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

function filesToScan() {
  const specs = walk(path.join(PLATFORM_ROOT, 'docs', 'specs'), (f) => f.endsWith('.md'));
  const readmes = walk(PLATFORM_ROOT, (f) => path.basename(f) === 'README.md');
  return [...new Set([...specs, ...readmes])].sort();
}

function main() {
  const problems = [];
  let refCount = 0;

  for (const file of filesToScan()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const match of line.matchAll(DEMO_REF)) {
        const rel = match[1];
        refCount += 1;
        if (!fs.existsSync(path.join(PLATFORM_ROOT, rel))) {
          problems.push({
            file: path.relative(PLATFORM_ROOT, file),
            line: i + 1,
            rel,
          });
        }
      }
    });
  }

  if (problems.length > 0) {
    console.error(`✗ ${problems.length} demo reference(s) point at files that do not exist:\n`);
    for (const p of problems) {
      console.error(`  ${p.file}:${p.line}  →  platform/${p.rel}  (missing)`);
    }
    console.error(
      `\nEither commit the artifact, or amend the claim to state the real proof ` +
        `(e.g. "demo script \`scripts/demos/<slug>.sh\` (recorded video pending)").`,
    );
    process.exit(1);
  }

  console.log(`✓ all ${refCount} demo reference(s) across specs/READMEs resolve to real files.`);
}

main();
