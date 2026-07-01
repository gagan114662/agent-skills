#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { argv, cwd, execPath, exit } from "node:process";

const require = createRequire(import.meta.url);

export function normalizeViteArgs(rawArgs) {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : [...rawArgs];
  const hasStrictPort = args.some((arg) => arg === "--strictPort" || arg === "--no-strictPort");
  return hasStrictPort ? args : [...args, "--strictPort"];
}

export function currentGitSha() {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: cwd(),
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function devBanner({ root = cwd(), sha = currentGitSha() } = {}) {
  return [
    "ipop web dev server",
    `- cwd: ${root}`,
    `- git: ${sha}`,
    "- ports: strict by default; stop the stale server or choose another port explicitly",
  ].join("\n");
}

if (import.meta.url === `file://${argv[1]}`) {
  const viteBin = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const viteArgs = normalizeViteArgs(argv.slice(2));

  console.log(devBanner());
  const child = spawn(execPath, [viteBin, ...viteArgs], {
    cwd: cwd(),
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`vite exited from signal ${signal}`);
      exit(1);
    }
    exit(code ?? 0);
  });
}
