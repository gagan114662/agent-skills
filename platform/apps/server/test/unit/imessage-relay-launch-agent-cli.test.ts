import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  installLaunchAgent,
  parseLaunchAgentConfig,
} from "../../src/imessage/relay-launch-agent-cli.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("iMessage relay LaunchAgent CLI (#1283)", () => {
  it("builds a persistent macOS relay plist without embedding the relay secret", () => {
    const config = parseLaunchAgentConfig({
      home: "/Users/gagan",
      argv: [
        "--label",
        "ai.ipop.test-relay",
        "--repo-dir",
        "/Users/gagan/agent skills",
        "--env-file",
        "~/.ipop/imessage-relay.env",
        "--log-dir",
        "~/.ipop/logs",
      ],
      env: { IMESSAGE_RELAY_WEBHOOK_SECRET: "do-not-embed" },
    });

    expect(config).toEqual({
      label: "ai.ipop.test-relay",
      repoDir: "/Users/gagan/agent skills",
      envFile: "/Users/gagan/.ipop/imessage-relay.env",
      plistPath: "/Users/gagan/Library/LaunchAgents/ai.ipop.test-relay.plist",
      logDir: "/Users/gagan/.ipop/logs",
    });

    const plist = buildLaunchAgentPlist(config);

    expect(plist).toContain("<string>ai.ipop.test-relay</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("exec pnpm -C platform --filter @reload/server imessage:relay");
    expect(plist).toContain("/Users/gagan/.ipop/imessage-relay.env");
    expect(plist).toContain("/Users/gagan/.ipop/logs/imessage-relay.err.log");
    expect(plist).not.toContain("do-not-embed");
  });

  it("installs the plist and creates its log directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipop-imessage-launch-agent-"));
    tempDirs.push(root);
    const config = parseLaunchAgentConfig({
      home: root,
      argv: ["--repo-dir", root, "--env-file", join(root, ".ipop", "imessage-relay.env")],
      env: {},
    });

    await installLaunchAgent(config);

    const plist = await readFile(config.plistPath, "utf8");
    expect(plist).toContain("<string>ai.ipop.imessage-relay</string>");
    expect(plist).toContain(config.envFile);
    expect(plist).toContain(join(root, ".ipop", "logs", "imessage-relay.out.log"));
  });
});
