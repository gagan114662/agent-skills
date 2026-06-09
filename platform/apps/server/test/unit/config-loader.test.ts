import { describe, it, expect } from "vitest";
import { loadConfig, mergeLayers, type ConfigSources } from "../../src/config/loader.js";
import { CONFIG_DEFAULTS } from "../../src/config/schema.js";

/**
 * File-backed config layering (#58). Precedence is **env < user < repo < managed** (managed is the
 * lock). These tests inject file contents + paths so nothing touches real disk.
 */

// Build sources whose injected reader returns canned TOML for the three known paths.
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

describe("config layering (#58 — env < user < repo < managed)", () => {
  it("falls back to defaults when no layer sets anything", () => {
    expect(loadConfig(undefined, sources({}))).toEqual(CONFIG_DEFAULTS);
  });

  it("resolves precedence: managed wins over repo wins over user wins over env", () => {
    const cfg = loadConfig(
      undefined,
      sources(
        {
          user: `workspaceRoot = "from-user"`,
          repo: `workspaceRoot = "from-repo"`,
          managed: `[settings]\nworkspaceRoot = "from-managed"`,
        },
        { RELOAD_WORKSPACE_ROOT: "from-env" },
      ),
    );
    expect(cfg.workspaceRoot).toBe("from-managed");
  });

  it("each higher layer overrides only the next, lower layers fill omitted fields", () => {
    // env sets workspaceRoot; user sets filesToCopy; repo sets dataPrivacyMode; nothing collides.
    const cfg = loadConfig(
      undefined,
      sources(
        { user: `filesToCopy = ["A.md"]`, repo: `dataPrivacyMode = true` },
        { RELOAD_WORKSPACE_ROOT: "ws-from-env" },
      ),
    );
    expect(cfg).toEqual({
      ...CONFIG_DEFAULTS,
      dataPrivacyMode: true,
      filesToCopy: ["A.md"],
      workspaceRoot: "ws-from-env",
    });
  });

  it("repo overrides user; user overrides env (without managed present)", () => {
    const cfg = loadConfig(
      undefined,
      sources(
        { user: `workspaceRoot = "u"`, repo: `workspaceRoot = "r"` },
        { RELOAD_WORKSPACE_ROOT: "e" },
      ),
    );
    expect(cfg.workspaceRoot).toBe("r");
  });
});

describe("managed/enterprise lock (#58)", () => {
  it("a managed setting cannot be overridden by repo, user, or env", () => {
    const cfg = loadConfig(
      undefined,
      sources(
        {
          user: `dataPrivacyMode = false`,
          repo: `dataPrivacyMode = false`,
          managed: `[settings]\ndataPrivacyMode = true`,
        },
        { RELOAD_DATA_PRIVACY_MODE: "false" },
      ),
    );
    expect(cfg.dataPrivacyMode).toBe(true); // managed is the lock
  });

  it("a per-tenant managed value wins for that tenant and beats managed-global", () => {
    const managed = `[settings]\ndataPrivacyMode = true\n\n[workspace.ws_acme]\ndataPrivacyMode = false`;
    expect(loadConfig("ws_acme", sources({ managed })).dataPrivacyMode).toBe(false);
  });

  it("a per-tenant managed value does NOT apply to a different tenant", () => {
    const managed = `[settings]\ndataPrivacyMode = true\n\n[workspace.ws_acme]\ndataPrivacyMode = false`;
    expect(loadConfig("ws_other", sources({ managed })).dataPrivacyMode).toBe(true); // global managed
  });
});

describe("model policy layer (#52)", () => {
  it("loads a tenant's model allow-list + defaults from the repo layer", () => {
    const repo = [
      `[models]`,
      `defaultProvider = "bedrock"`,
      `allowedProviders = ["bedrock", "anthropic"]`,
      `defaultEffort = "high"`,
      `[models.providers.bedrock]`,
      `region = "eu-west-1"`,
    ].join("\n");
    const cfg = loadConfig(undefined, sources({ repo }));
    expect(cfg.models.defaultProvider).toBe("bedrock");
    expect(cfg.models.allowedProviders).toEqual(["bedrock", "anthropic"]);
    expect(cfg.models.defaultEffort).toBe("high");
    expect(cfg.models.providers?.bedrock?.region).toBe("eu-west-1");
  });

  it("a managed model allow-list is the lock — a lower layer cannot widen it", () => {
    const managed = `[settings.models]\nallowedProviders = ["anthropic"]`;
    const repo = `[models]\nallowedProviders = ["anthropic", "openai", "custom"]`;
    const cfg = loadConfig(undefined, sources({ managed, repo }));
    expect(cfg.models.allowedProviders).toEqual(["anthropic"]); // managed wins (replace, not merge)
  });

  it("rejects an unknown provider in the allow-list (schema-validated, content-free)", () => {
    expect(() => loadConfig(undefined, sources({ repo: `[models]\nallowedProviders = ["skynet"]` }))).toThrowError(
      /allowedProviders/,
    );
  });
});

describe("validation & resilience (#58)", () => {
  it("rejects a type-invalid value with a clear, content-free error", () => {
    expect(() => loadConfig(undefined, sources({ repo: `dataPrivacyMode = "yes"` }))).toThrowError(
      /dataPrivacyMode/,
    );
  });

  it("strips unknown keys (forward-compatible)", () => {
    const cfg = loadConfig(undefined, sources({ repo: `someFutureKey = "x"\nworkspaceRoot = "r"` }));
    expect(cfg).toEqual({ ...CONFIG_DEFAULTS, workspaceRoot: "r" });
    expect((cfg as Record<string, unknown>).someFutureKey).toBeUndefined();
  });

  it("degrades a malformed TOML file to an absent layer (does not crash or leak)", () => {
    const cfg = loadConfig(
      undefined,
      sources({ repo: `this is = = not valid toml [[[`, user: `workspaceRoot = "u"` }),
    );
    expect(cfg.workspaceRoot).toBe("u"); // repo dropped, user still applies
  });

  it("never surfaces a secret-looking key from a layer into the resolved config", () => {
    const cfg = loadConfig(undefined, sources({ user: `ANTHROPIC_API_KEY = "sk-leak"\nworkspaceRoot = "u"` }));
    expect(JSON.stringify(cfg)).not.toContain("sk-leak");
    expect(JSON.stringify(cfg)).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("env layer parsing (#58)", () => {
  it("parses RELOAD_DATA_PRIVACY_MODE, RELOAD_FILES_TO_COPY (JSON or CSV), RELOAD_WORKSPACE_ROOT", () => {
    const json = loadConfig(undefined, {
      env: {
        RELOAD_DATA_PRIVACY_MODE: "true",
        RELOAD_FILES_TO_COPY: `["A.md","B.md"]`,
        RELOAD_WORKSPACE_ROOT: "/srv/ws",
      },
      readFile: () => undefined,
    });
    expect(json).toEqual({
      ...CONFIG_DEFAULTS,
      dataPrivacyMode: true,
      filesToCopy: ["A.md", "B.md"],
      workspaceRoot: "/srv/ws",
    });

    const csv = loadConfig(undefined, {
      env: { RELOAD_FILES_TO_COPY: "A.md, B.md" },
      readFile: () => undefined,
    });
    expect(csv.filesToCopy).toEqual(["A.md", "B.md"]);
  });
});

describe("mergeLayers (pure precedence helper)", () => {
  it("applies layers low→high, last-defined-per-field wins, arrays replace not concat", () => {
    expect(
      mergeLayers([{ filesToCopy: ["a"] }, { filesToCopy: ["b", "c"] }, { workspaceRoot: "w" }]),
    ).toEqual({ ...CONFIG_DEFAULTS, dataPrivacyMode: false, filesToCopy: ["b", "c"], workspaceRoot: "w" });
  });
});
