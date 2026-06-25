#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assert,
  assertScreenshotQuality,
  checkLiveUrl,
  compareImages,
  readPng,
} from "./visual-match-core.mjs";

function parseArgs(argv) {
  const args = { manifest: "gallery/visual-match.manifest.json", live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--live") args.live = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/visual-match.mjs [--manifest path] [--live]

Verifies screenshot evidence from a manifest. Each target must provide a reference PNG and may provide a
candidate PNG to compare against it. Live checks are opt-in with --live so normal CI does not depend on
ipop.ai availability.`);
}

async function loadManifest(path) {
  const abs = resolve(path);
  return { abs, data: JSON.parse(await readFile(abs, "utf8")) };
}

async function verifyTarget(target) {
  assert(target.name, "visual target is missing name");
  assert(target.reference, `${target.name}: missing reference screenshot`);
  const reference = await readPng(target.reference);
  const referenceStats = assertScreenshotQuality(`${target.name} reference`, reference, target.quality);
  const result = {
    name: target.name,
    reference: target.reference,
    width: reference.width,
    height: reference.height,
    referenceSha256: reference.sha256,
    referenceBytes: reference.bytes,
    referenceStats,
  };
  if (target.candidate) {
    const candidate = await readPng(target.candidate);
    const candidateStats = assertScreenshotQuality(`${target.name} candidate`, candidate, target.quality);
    const comparison = compareImages(reference, candidate);
    const maxRms = target.maxRms ?? 0;
    const maxDiffPct = target.maxDiffPct ?? 0;
    assert(comparison.rms <= maxRms, `${target.name}: RMS ${comparison.rms.toFixed(3)} exceeds ${maxRms}`);
    assert(
      comparison.diffPct <= maxDiffPct,
      `${target.name}: diff ${(comparison.diffPct * 100).toFixed(3)}% exceeds ${(maxDiffPct * 100).toFixed(3)}%`,
    );
    Object.assign(result, {
      candidate: target.candidate,
      candidateSha256: candidate.sha256,
      candidateBytes: candidate.bytes,
      candidateStats,
      comparison,
    });
  }
  return result;
}

export async function run(argv = process.argv.slice(2), fetchImpl = fetch) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return { ok: true, help: true };
  }
  const { abs, data } = await loadManifest(args.manifest);
  const baseDir = new URL("../", import.meta.url).pathname;
  const targets = data.targets ?? [];
  assert(targets.length > 0, "manifest has no visual targets");
  const cwd = process.cwd();
  process.chdir(baseDir);
  try {
    const visual = [];
    for (const target of targets) {
      visual.push(await verifyTarget(target));
    }
    const live = [];
    if (args.live) {
      for (const check of data.liveChecks ?? []) {
        live.push({ name: check.name, url: check.url, ...(await checkLiveUrl(check, fetchImpl)) });
      }
    }
    return {
      ok: true,
      manifest: abs,
      checkedAt: new Date().toISOString(),
      visual,
      live,
      liveSkipped: !args.live && (data.liveChecks?.length ?? 0) > 0,
    };
  } finally {
    process.chdir(cwd);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
