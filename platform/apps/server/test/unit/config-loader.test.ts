import { describe, it, expect } from "vitest";
import { loadConfig, mergeLayers, type ConfigSources } from "../../src/config/loader.js";
import { CONFIG_DEFAULTS } from "../../src/config/schema.js";
import { resolveScaleCaps } from "../../src/scale/caps.js";
import { resolveVentureCaps } from "../../src/venture/caps.js";

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

describe("auto model-selection config (convene-llm-gateway)", () => {
  it("defaults OFF — an unset autoModel block resolves to {} (today's behavior)", () => {
    expect(loadConfig(undefined, sources({})).autoModel).toEqual({});
  });

  it("survives the layer merge — the block is NOT silently dropped (mergeSettings/mergeLayers gotcha)", () => {
    const cfg = loadConfig(undefined, sources({ repo: `[autoModel]\nenabled = true\nmaxCallCostCents = 7` }));
    expect(cfg.autoModel).toEqual({ enabled: true, maxCallCostCents: 7 });
  });

  it("can be enabled for the OWNER workspace only via a managed per-tenant override", () => {
    // The rollout shape: master switch (RELOAD_AUTO_MODEL) + LLM_GATEWAY_URL in env, and the owner
    // workspace flipped on in the managed layer; every other tenant stays off.
    const managed = `[workspace.ws_owner.autoModel]\nenabled = true`;
    expect(loadConfig("ws_owner", sources({ managed })).autoModel).toEqual({ enabled: true });
    expect(loadConfig("ws_other", sources({ managed })).autoModel).toEqual({}); // off for everyone else
  });

  it("managed is the lock — a lower layer cannot turn auto on when managed pins it off", () => {
    const managed = `[settings.autoModel]\nenabled = false`;
    const repo = `[autoModel]\nenabled = true`;
    expect(loadConfig(undefined, sources({ managed, repo })).autoModel).toEqual({ enabled: false });
  });
});

describe("real-world tool surface config (#231)", () => {
  it("defaults OFF — an unset realworld block resolves to {} (publish stays dryrun)", () => {
    expect(loadConfig(undefined, sources({})).realworld).toEqual({});
  });

  it("survives the layer merge — the block is NOT silently dropped (mergeSettings/mergeLayers gotcha)", () => {
    const cfg = loadConfig(undefined, sources({ repo: `[realworld]\nenabled = true\npublishProvider = "github_pages"` }));
    expect(cfg.realworld).toEqual({ enabled: true, publishProvider: "github_pages" });
  });

  it("env opts a workspace in without a managed.toml (RELOAD_REALWORLD_* → block)", () => {
    const cfg = loadConfig(
      undefined,
      sources({}, { RELOAD_REALWORLD_ENABLED: "true", RELOAD_REALWORLD_PUBLISH_PROVIDER: "github_pages" }),
    );
    expect(cfg.realworld).toEqual({ enabled: true, publishProvider: "github_pages" });
  });

  it("managed is the lock — a lower layer cannot turn the surface on when managed pins it off", () => {
    const managed = `[settings.realworld]\nenabled = false`;
    const repo = `[realworld]\nenabled = true`;
    expect(loadConfig(undefined, sources({ managed, repo })).realworld).toEqual({ enabled: false });
  });

  it("#262 connect-Claude defaults OFF, and env opts the owner workspace in (RELOAD_CONNECT_CLAUDE_*)", () => {
    expect(loadConfig(undefined, sources({})).connectClaude).toEqual({});
    const cfg = loadConfig(
      undefined,
      sources(
        {},
        { RELOAD_CONNECT_CLAUDE_ENABLED: "true", RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID: "ws_owner" },
      ),
    );
    expect(cfg.connectClaude).toEqual({ enabled: true, ownerWorkspaceId: "ws_owner" });
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

  it("parses the #138 marketing enablement env vars (so fly.toml can turn the fleet on in prod)", () => {
    const cfg = loadConfig(undefined, {
      env: { RELOAD_MARKETING_ENABLED: "true", RELOAD_MARKETING_SEED_WELCOME_TASKS: "false" },
      readFile: () => undefined,
    });
    expect(cfg.marketing).toEqual({ enabled: true, seedWelcomeTasks: false });
  });

  it("leaves marketing absent (default OFF) when the env vars are unset", () => {
    const cfg = loadConfig(undefined, { env: {}, readFile: () => undefined });
    expect(cfg.marketing).toEqual(CONFIG_DEFAULTS.marketing);
  });

  it("lets a managed layer still override env marketing (managed is the lock)", () => {
    const cfg = loadConfig(undefined, {
      env: { RELOAD_MARKETING_ENABLED: "true" },
      readFile: (p) => (p.includes("managed") ? `[settings.marketing]\nenabled = false` : undefined),
      managedPath: "/etc/reload/managed.toml",
    });
    expect(cfg.marketing.enabled).toBe(false);
  });

  it("#98 RELOAD_BILLING_ENABLED presents the [billing] section so the checkout gate opens (provider mirrors BILLING_PROVIDER)", () => {
    const cfg = loadConfig(undefined, {
      env: { RELOAD_BILLING_ENABLED: "true", BILLING_PROVIDER: "stripe" },
      readFile: () => undefined,
    });
    expect(cfg.billing).toEqual({ provider: "stripe" });
  });

  it("billing stays absent (default OFF → checkout 409s) when RELOAD_BILLING_ENABLED is unset", () => {
    const cfg = loadConfig(undefined, { env: { BILLING_PROVIDER: "stripe" }, readFile: () => undefined });
    expect(cfg.billing).toBeUndefined();
  });

  it("billing-enabled with no/none BILLING_PROVIDER still opens the gate but provider falls back to none", () => {
    const cfg = loadConfig(undefined, { env: { RELOAD_BILLING_ENABLED: "1" }, readFile: () => undefined });
    expect(cfg.billing).toEqual({ provider: "none" });
  });

  it("a managed per-tenant [workspace.<id>].billing still wins over the env flag (managed is the lock)", () => {
    const wid = "019eb395-f4a4-796e-9ef0-3a538533566a";
    const cfg = loadConfig(wid, {
      env: { RELOAD_BILLING_ENABLED: "true", BILLING_PROVIDER: "stripe" },
      readFile: (p) =>
        p.includes("managed") ? `[workspace."${wid}".billing]\nprovider = "stripe"\ncurrency = "usd"` : undefined,
      managedPath: "/etc/reload/managed.toml",
    });
    expect(cfg.billing).toEqual({ provider: "stripe", currency: "usd" });
  });
});

describe("trial free-tier caps (default-ON — the product's free tier)", () => {
  it("default-ON: a workspace with no plan/config gets usable trial caps (concurrency 1, budget 500)", () => {
    // Unlike every other config block (which defaults OFF), the scale free-tier is ON by default so a
    // fresh/owner workspace can run agents BEFORE checkout is wired (ADR-0147). 0 caps = "unlimited" in
    // admission, so the bug was the *absence* of a usable tier, not a too-low one.
    const cfg = loadConfig(undefined, { env: {}, readFile: () => undefined });
    expect(cfg.scale).toEqual({ tenantConcurrency: 1, budgetCents: 500 });
    // The fleet-wide ceiling is NOT a trial concern — it stays unset (env default / unlimited).
    expect(cfg.scale.globalConcurrency).toBeUndefined();
  });

  it("RELOAD_TRIAL_TENANT_CONCURRENCY / RELOAD_TRIAL_BUDGET_CENTS tune the free tier", () => {
    const cfg = loadConfig(undefined, {
      env: { RELOAD_TRIAL_TENANT_CONCURRENCY: "3", RELOAD_TRIAL_BUDGET_CENTS: "2000" },
      readFile: () => undefined,
    });
    expect(cfg.scale).toEqual({ tenantConcurrency: 3, budgetCents: 2000 });
  });

  it("RELOAD_TRIAL_ENABLED=false turns the free tier off (back to today's unlimited default)", () => {
    const cfg = loadConfig(undefined, {
      env: { RELOAD_TRIAL_ENABLED: "false" },
      readFile: () => undefined,
    });
    expect(cfg.scale).toEqual({}); // no trial block → resolveScaleCaps yields 0 = unlimited
    expect(resolveScaleCaps(cfg.scale).tenantConcurrency).toBe(0);
  });

  it("a managed per-tenant [scale] fully REPLACES the trial caps (a paid plan wins, like every block)", () => {
    // When checkout→caps is wired it writes a per-tenant managed [workspace.<id>.scale]; the replace
    // semantics mean the paying tenant escapes the trial cap automatically (the same mechanism used to
    // unblock the owner workspace on prod today).
    const managed = `[workspace.ws_paid.scale]\ntenantConcurrency = 10\nbudgetCents = 100000`;
    const paid = loadConfig("ws_paid", sources({ managed }));
    expect(paid.scale).toEqual({ tenantConcurrency: 10, budgetCents: 100000 });

    // A different tenant with no managed override keeps the trial free tier.
    const free = loadConfig("ws_free", sources({ managed }));
    expect(free.scale).toEqual({ tenantConcurrency: 1, budgetCents: 500 });
  });
});

describe("run command config (#56)", () => {
  it("is undefined when no layer sets it (Run tab → 409)", () => {
    expect(loadConfig(undefined, sources({})).run).toBeUndefined();
  });

  it("resolves a repo-scope run command, and managed fully replaces it", () => {
    const repoOnly = loadConfig(
      undefined,
      sources({ repo: `[run]\ncommand = "pnpm dev"\nport = 3000` }),
    );
    expect(repoOnly.run).toEqual({ command: "pnpm dev", port: 3000 });

    const managedWins = loadConfig(
      undefined,
      sources({
        repo: `[run]\ncommand = "pnpm dev"\nport = 3000`,
        managed: `[settings.run]\ncommand = "make serve"`,
      }),
    );
    expect(managedWins.run).toEqual({ command: "make serve" });
  });

  it("rejects an invalid run command (missing command field)", () => {
    expect(() => loadConfig(undefined, sources({ repo: `[run]\nport = 3000` }))).toThrow();
  });
});

describe("#228 venture gate env wiring (RELOAD_VENTURE_*)", () => {
  it("defaults the venture gate OFF (empty block) when no env/config sets it", () => {
    const cfg = loadConfig(undefined, sources({}));
    expect(cfg.venture).toEqual({});
    expect(resolveVentureCaps(cfg.venture).enabled).toBe(false);
  });

  it("turns the gate on owner-first, reusing the marketing owner workspace marker", () => {
    const cfg = loadConfig(
      undefined,
      sources(
        {},
        { RELOAD_VENTURE_ENABLED: "true", RELOAD_MARKETING_OWNER_WORKSPACE_ID: "ws-owner" },
      ),
    );
    expect(cfg.venture).toEqual({ enabled: true, ownerWorkspaceId: "ws-owner" });
  });

  it("a dedicated RELOAD_VENTURE_OWNER_WORKSPACE_ID overrides the marketing marker", () => {
    const cfg = loadConfig(
      undefined,
      sources(
        {},
        {
          RELOAD_VENTURE_ENABLED: "1",
          RELOAD_MARKETING_OWNER_WORKSPACE_ID: "ws-mkt",
          RELOAD_VENTURE_OWNER_WORKSPACE_ID: "ws-venture",
        },
      ),
    );
    expect(cfg.venture).toEqual({ enabled: true, ownerWorkspaceId: "ws-venture" });
  });
});

describe("mergeLayers (pure precedence helper)", () => {
  it("applies layers low→high, last-defined-per-field wins, arrays replace not concat", () => {
    expect(
      mergeLayers([{ filesToCopy: ["a"] }, { filesToCopy: ["b", "c"] }, { workspaceRoot: "w" }]),
    ).toEqual({ ...CONFIG_DEFAULTS, dataPrivacyMode: false, filesToCopy: ["b", "c"], workspaceRoot: "w" });
  });
});
