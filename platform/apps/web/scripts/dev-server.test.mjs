import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { devBanner, normalizeViteArgs } from "./dev-server.mjs";

describe("dev-server", () => {
  it("strips pnpm passthrough separator before handing args to Vite", () => {
    assert.deepEqual(normalizeViteArgs(["--", "--host", "127.0.0.1", "--port", "5173"]), [
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ]);
  });

  it("does not add duplicate strict port flags", () => {
    assert.deepEqual(normalizeViteArgs(["--port", "5173", "--strictPort"]), [
      "--port",
      "5173",
      "--strictPort",
    ]);
  });

  it("lets callers explicitly opt out of strict port behavior", () => {
    assert.deepEqual(normalizeViteArgs(["--port", "5173", "--no-strictPort"]), [
      "--port",
      "5173",
      "--no-strictPort",
    ]);
  });

  it("prints the worktree and commit context before startup", () => {
    const banner = devBanner({ root: "/work/agent-skills", sha: "abc123def456" });
    assert.match(banner, /cwd: \/work\/agent-skills/);
    assert.match(banner, /git: abc123def456/);
    assert.match(banner, /strict by default/);
  });
});
