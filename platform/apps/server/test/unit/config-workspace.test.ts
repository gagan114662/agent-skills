import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfigWorkspaceProvisioner } from "../../src/config/workspace.js";
import type { ResolvedConfig } from "../../src/config/schema.js";

/**
 * Files-to-copy on session create (#58). The provisioner materializes a per-session working dir
 * under `workspaceRoot/<sessionId>` and copies the configured files into it. Tests run against a
 * real temp dir.
 */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "reload-cfg-"));
}

function provisioner(base: string, cfg: Partial<ResolvedConfig>) {
  const resolved: ResolvedConfig = {
    dataPrivacyMode: false,
    filesToCopy: [],
    workspaceRoot: "ws",
    ...cfg,
  };
  return new FileConfigWorkspaceProvisioner({ baseDir: base, loadConfig: () => resolved });
}

describe("FileConfigWorkspaceProvisioner (#58 — files-to-copy land in a new session workspace)", () => {
  it("creates workspaceRoot/<sessionId> and copies the configured files into it", async () => {
    const base = tmp();
    writeFileSync(join(base, "AGENTS.md"), "hello agents");

    const { cwd } = await provisioner(base, { filesToCopy: ["AGENTS.md"] }).prepare({
      sessionId: "sess_1",
      workspaceId: "ws_1",
    });

    expect(cwd).toBe(join(base, "ws", "sess_1"));
    expect(existsSync(join(cwd!, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(cwd!, "AGENTS.md"), "utf8")).toBe("hello agents");
  });

  it("skips a missing source file without throwing, still copies the rest", async () => {
    const base = tmp();
    writeFileSync(join(base, "present.md"), "ok");

    const { cwd } = await provisioner(base, {
      filesToCopy: ["absent.md", "present.md"],
    }).prepare({ sessionId: "sess_2", workspaceId: "ws_1" });

    expect(existsSync(join(cwd!, "present.md"))).toBe(true);
    expect(existsSync(join(cwd!, "absent.md"))).toBe(false);
  });

  it("contains the copy to the session dir using the source basename (path traversal guard)", async () => {
    const base = tmp();
    mkdirSync(join(base, "docs"));
    writeFileSync(join(base, "docs", "ctx.md"), "ctx");

    const { cwd } = await provisioner(base, { filesToCopy: ["docs/ctx.md"] }).prepare({
      sessionId: "sess_3",
      workspaceId: "ws_1",
    });

    // Destination is flattened to the basename inside the session dir — cannot escape it.
    expect(existsSync(join(cwd!, "ctx.md"))).toBe(true);
  });

  it("returns the session dir even when nothing is configured to copy", async () => {
    const base = tmp();
    const { cwd } = await provisioner(base, { filesToCopy: [] }).prepare({
      sessionId: "sess_4",
      workspaceId: "ws_1",
    });
    expect(existsSync(cwd!)).toBe(true);
  });
});
