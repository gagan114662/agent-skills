#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const WEB_RELEVANT_PREFIXES = [
  "apps/web/",
  "packages/shared/",
];

const WEB_RELEVANT_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vercel.json",
]);

export function shouldBuild({ env = process.env, changedFiles }) {
  if (env.VERCEL_ENV === "production") {
    return { build: true, reason: "production deployment" };
  }

  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { build: true, reason: "no reliable changed-file list" };
  }

  const relevant = changedFiles.filter(isWebRelevantPath);
  if (relevant.length > 0) {
    return { build: true, reason: "web-relevant changes: " + relevant.join(", ") };
  }

  return { build: false, reason: "preview has no web/shared/build-config changes" };
}

export function isWebRelevantPath(file) {
  return WEB_RELEVANT_FILES.has(file) || WEB_RELEVANT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function changedFilesFromGit(env = process.env) {
  const head = env.VERCEL_GIT_COMMIT_SHA;
  const base = env.VERCEL_GIT_PREVIOUS_SHA || head + "^";
  if (!head) return [];
  try {
    return execFileSync("git", ["diff", "--name-only", base, head], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    try {
      return execFileSync("git", ["show", "--name-only", "--format=", head], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

if (import.meta.url === "file://" + process.argv[1]) {
  const decision = shouldBuild({ changedFiles: changedFilesFromGit() });
  console.log((decision.build ? "Vercel build required: " : "Vercel build skipped: ") + decision.reason);
  process.exit(decision.build ? 1 : 0);
}
