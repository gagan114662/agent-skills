#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LaunchAgentConfig {
  label: string;
  repoDir: string;
  envFile: string;
  plistPath: string;
  logDir: string;
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function defaultRepoDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "..", "..", "..", "..");
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function parseLaunchAgentConfig(input: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): LaunchAgentConfig {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const label = argValue(argv, "--label") ?? env.IMESSAGE_RELAY_LAUNCH_LABEL?.trim() ?? "ai.ipop.imessage-relay";
  const repoDir = resolve(
    expandHome(argValue(argv, "--repo-dir") ?? env.IMESSAGE_RELAY_REPO_DIR?.trim() ?? defaultRepoDir(), home),
  );
  const envFile = resolve(
    expandHome(argValue(argv, "--env-file") ?? env.IMESSAGE_RELAY_ENV_FILE?.trim() ?? "~/.ipop/imessage-relay.env", home),
  );
  const logDir = resolve(
    expandHome(argValue(argv, "--log-dir") ?? env.IMESSAGE_RELAY_LOG_DIR?.trim() ?? "~/.ipop/logs", home),
  );
  const plistPath = resolve(
    expandHome(
      argValue(argv, "--plist-path") ??
        env.IMESSAGE_RELAY_LAUNCH_PLIST?.trim() ??
        "~/Library/LaunchAgents/" + label + ".plist",
      home,
    ),
  );
  return { label, repoDir, envFile, plistPath, logDir };
}

export function buildLaunchAgentPlist(config: LaunchAgentConfig): string {
  const command = [
    "set -eu",
    "test -f " + shellQuote(config.envFile),
    "cd " + shellQuote(config.repoDir),
    "set -a",
    ". " + shellQuote(config.envFile),
    "set +a",
    "exec pnpm -C platform --filter @reload/server imessage:relay",
  ].join("; ");
  const stdout = join(config.logDir, "imessage-relay.out.log");
  const stderr = join(config.logDir, "imessage-relay.err.log");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + xmlEscape(config.label) + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/zsh</string>",
    "    <string>-lc</string>",
    "    <string>" + xmlEscape(command) + "</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>WorkingDirectory</key>",
    "  <string>" + xmlEscape(config.repoDir) + "</string>",
    "  <key>StandardOutPath</key>",
    "  <string>" + xmlEscape(stdout) + "</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>" + xmlEscape(stderr) + "</string>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function installLaunchAgent(config: LaunchAgentConfig): Promise<void> {
  await mkdir(dirname(config.plistPath), { recursive: true });
  await mkdir(config.logDir, { recursive: true });
  await writeFile(config.plistPath, buildLaunchAgentPlist(config), { encoding: "utf8", mode: 0o644 });
}

export function launchAgentUsage(): string {
  return [
    "Usage: imessage:relay:launch-agent -- --print|--install [options]",
    "",
    "Options:",
    "  --label <label>         launchd label (default: ai.ipop.imessage-relay)",
    "  --repo-dir <path>       agent-skills repo root (default: current installed repo)",
    "  --env-file <path>       relay env file (default: ~/.ipop/imessage-relay.env)",
    "  --plist-path <path>     output plist path (default: ~/Library/LaunchAgents/<label>.plist)",
    "  --log-dir <path>        stdout/stderr log directory (default: ~/.ipop/logs)",
    "",
    "The plist sources the env file at runtime. It never embeds the relay secret.",
  ].join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = parseLaunchAgentConfig({ argv });
  if (flag(argv, "--print")) {
    process.stdout.write(buildLaunchAgentPlist(config));
    return;
  }
  if (flag(argv, "--install")) {
    await installLaunchAgent(config);
    console.log("installed " + config.plistPath);
    console.log("load with: launchctl bootstrap gui/$(id -u) " + shellQuote(config.plistPath));
    console.log("restart with: launchctl kickstart -k gui/$(id -u)/" + config.label);
    console.log("unload with: launchctl bootout gui/$(id -u) " + shellQuote(config.plistPath));
    return;
  }
  console.error(launchAgentUsage());
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
