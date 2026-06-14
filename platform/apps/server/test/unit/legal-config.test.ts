import { describe, it, expect } from "vitest";
import { loadConfig, type ConfigSources } from "../../src/config/loader.js";

// Build sources whose injected reader returns canned TOML for the three known paths (mirrors
// config-loader.test.ts). Proves the #196 `legal` block survives the layer merge + the default-OFF +
// owner-only-via-managed rollout shape.
function sources(files: { user?: string; repo?: string; managed?: string }, env: NodeJS.ProcessEnv = {}): ConfigSources {
  const map: Record<string, string> = {};
  if (files.user !== undefined) map["/u/settings.toml"] = files.user;
  if (files.repo !== undefined) map["/r/settings.toml"] = files.repo;
  if (files.managed !== undefined) map["/m/managed.toml"] = files.managed;
  return {
    env,
    userPath: "/u/settings.toml",
    repoPath: "/r/settings.toml",
    managedPath: "/m/managed.toml",
    readFile: (p) => map[p],
  };
}

describe("legal & compliance config (#196)", () => {
  it("defaults OFF — an unset legal block resolves to {} (today's behavior)", () => {
    expect(loadConfig(undefined, sources({})).legal).toEqual({});
  });

  it("survives the layer merge — the block is NOT silently dropped (mergeSettings/mergeLayers gotcha)", () => {
    const cfg = loadConfig(undefined, sources({ repo: `[legal]\nenabled = true\nautoRegenerate = true` }));
    expect(cfg.legal).toEqual({ enabled: true, autoRegenerate: true });
  });

  it("can be enabled for the OWNER workspace only via a managed per-tenant override", () => {
    const managed = `[workspace.ws_owner.legal]\nenabled = true`;
    expect(loadConfig("ws_owner", sources({ managed })).legal).toEqual({ enabled: true });
    expect(loadConfig("ws_other", sources({ managed })).legal).toEqual({}); // off for everyone else
  });

  it("managed is the lock — a lower layer cannot turn the pack on when managed pins it off", () => {
    const managed = `[settings.legal]\nenabled = false`;
    const repo = `[legal]\nenabled = true`;
    expect(loadConfig(undefined, sources({ managed, repo })).legal).toEqual({ enabled: false });
  });
});
