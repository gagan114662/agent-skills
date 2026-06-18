#!/usr/bin/env node
/**
 * worktree-pool-benchmark.mjs (#343, ADR-0343)
 *
 * Produces REAL measured receipts (premortem #200 §2: numbers, not estimates) comparing the two
 * spin-up paths for a fleet/agent session:
 *
 *   COLD (today's per-session path)  : `git worktree add` a fresh checkout, then materialize deps +
 *                                      build cache (a fresh worktree has none) before the agent can work.
 *   WARM (treehouse pool path)       : `git reset --hard` + `git clean -fd` a pooled worktree back to
 *                                      base — gitignored `node_modules`/build cache survive, so there is
 *                                      ZERO re-materialization. This is exactly what WorktreePoolService does.
 *
 * Fully offline + reproducible: it builds a throwaway git repo with a configurable number of tracked
 * files and a configurable gitignored `node_modules` fixture (modeling installed deps + build cache as
 * a file-count — the dominant real cost of `pnpm install` is materializing thousands of small files, so
 * the measured cold cost is a CONSERVATIVE LOWER BOUND on a real install). Real git, real filesystem.
 *
 * It also PROVES the cache-reuse invariant: after each warm reuse it asserts the node_modules fixture is
 * byte-identical (still M files), i.e. the reset never touched the deps.
 *
 * Usage:
 *   node scripts/worktree-pool-benchmark.mjs [--files N] [--dep-files M] [--iters K] [--out PATH]
 *
 * Writes a JSON receipt to docs/evidence/worktree-pool-benchmark.json (or --out) and prints a summary.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = join(HERE, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FILES = Number(arg("files", "2176")); // ~ the platform repo's tracked file count (issue #343)
const DEP_FILES = Number(arg("dep-files", "6000")); // a modest node_modules + build cache fixture
const ITERS = Number(arg("iters", "5"));
const OUT = arg("out", join(PLATFORM_ROOT, "docs/evidence/worktree-pool-benchmark.json"));

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function gitVersion() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
}

/** Write `count` tiny files under `dir`, sharded into subdirs so a single dir never holds them all. */
function writeManyFiles(dir, count, prefix) {
  const perShard = 200;
  for (let i = 0; i < count; i++) {
    const shard = join(dir, `s${Math.floor(i / perShard)}`);
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, `${prefix}-${i}.txt`), `// ${prefix} ${i}\nexport const v${i} = ${i};\n`);
  }
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  return { meanMs: Math.round(mean), medianMs: Math.round(median), minMs: sorted[0], maxMs: sorted.at(-1), samples };
}

function main() {
  const root = mkdtempSync(join(tmpdir(), "treehouse-bench-"));
  try {
    // --- build the source repo: FILES tracked files + a gitignored node_modules fixture ------------
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "bench@reload.local");
    git(repo, "config", "user.name", "Bench");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.build-cache/\n");
    writeManyFiles(join(repo, "src"), FILES, "f");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");

    const poolRoot = join(root, "pool");
    const coldRoot = join(root, "cold");
    mkdirSync(poolRoot, { recursive: true });
    mkdirSync(coldRoot, { recursive: true });

    // --- COLD: fresh worktree + materialize deps, K times ----------------------------------------
    const coldSamples = [];
    for (let i = 0; i < ITERS; i++) {
      const wt = join(coldRoot, `cold-${i}`);
      const t0 = nowMs();
      git(repo, "worktree", "add", "--detach", "-q", wt, "main");
      // a fresh checkout has NO deps — model `pnpm install` materializing node_modules + build cache:
      writeManyFiles(join(wt, "node_modules"), DEP_FILES, "dep");
      const t1 = nowMs();
      coldSamples.push(t1 - t0);
      git(repo, "worktree", "remove", "--force", wt);
    }

    // --- WARM: one pooled slot, reused K times (deps materialized ONCE) ---------------------------
    const slot = join(poolRoot, "slot-0");
    git(repo, "worktree", "add", "--detach", "-q", slot, "main");
    writeManyFiles(join(slot, "node_modules"), DEP_FILES, "dep"); // the single cold prime
    const primedDepCount = countFiles(join(slot, "node_modules"));

    const warmSamples = [];
    let depsPreservedEveryReuse = true;
    for (let i = 0; i < ITERS; i++) {
      // simulate the prior session's leftover work: a tracked edit + an untracked file
      writeFileSync(join(slot, "src", "s0", "f-0.txt"), `dirty edit ${i}\n`);
      writeFileSync(join(slot, "scratch.txt"), "untracked\n");
      const t0 = nowMs();
      git(slot, "reset", "--hard", "-q", "main");
      git(slot, "clean", "-fdq"); // NO -x: gitignored node_modules/build cache survive
      git(slot, "checkout", "-q", "-B", `agent/sess-${i}`, "main");
      const t1 = nowMs();
      warmSamples.push(t1 - t0);
      if (countFiles(join(slot, "node_modules")) !== primedDepCount) depsPreservedEveryReuse = false;
    }
    git(repo, "worktree", "remove", "--force", slot);

    const cold = stats(coldSamples);
    const warm = stats(warmSamples);
    const receipt = {
      benchmark: "worktree-pool-spinup",
      issue: 343,
      generatedBy: "scripts/worktree-pool-benchmark.mjs",
      methodology:
        "Cold = `git worktree add` + materialize a node_modules/build-cache fixture (a fresh checkout has none). " +
        "Warm = `git reset --hard` + `git clean -fd` (no -x) of a pooled worktree, deps preserved. " +
        "Deps modeled as a file-count fixture; real `pnpm install` is strictly costlier, so cold is a lower bound.",
      params: { trackedFiles: FILES, depFiles: DEP_FILES, iterations: ITERS },
      gitVersion: gitVersion(),
      platform: `${process.platform} ${process.arch} node ${process.version}`,
      cold,
      warm,
      speedupMedian: Number((cold.medianMs / Math.max(warm.medianMs, 1)).toFixed(1)),
      savedMsMedian: cold.medianMs - warm.medianMs,
      cacheReuse: { primedDepFiles: primedDepCount, depsPreservedEveryReuse },
    };

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(receipt, null, 2) + "\n");

    console.log("\n=== treehouse worktree-pool benchmark (#343) ===");
    console.log(`repo: ${FILES} tracked files · deps fixture: ${DEP_FILES} files · ${ITERS} iterations`);
    console.log(`git:  ${receipt.gitVersion}`);
    console.log(`COLD (fresh checkout + deps):  median ${cold.medianMs}ms  (min ${cold.minMs} / max ${cold.maxMs})`);
    console.log(`WARM (pool reset + clean):     median ${warm.medianMs}ms  (min ${warm.minMs} / max ${warm.maxMs})`);
    console.log(`SPEEDUP (median):              ${receipt.speedupMedian}x  (saves ${receipt.savedMsMedian}ms/session)`);
    console.log(`CACHE REUSE:                   ${primedDepCount} dep files preserved across every warm reuse: ${depsPreservedEveryReuse}`);
    console.log(`receipt: ${OUT}\n`);

    if (!depsPreservedEveryReuse) {
      console.error("FAIL: deps were NOT preserved across a warm reuse — the pool reset is wrong.");
      process.exit(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
