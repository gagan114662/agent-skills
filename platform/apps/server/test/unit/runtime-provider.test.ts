import { describe, expect, it } from "vitest";
import {
  createClaudeRuntimeStatusProvider,
  createRuntimeStatusProvider,
  harnessForProvider,
  isRuntimeProvider,
  parseRuntimeProvider,
  runtimeStatusFromCodex,
  DEFAULT_RUNTIME_PROVIDER,
  type CodexSubscriptionStatus,
} from "../../src/runtime/provider.js";

describe("runtime provider selection (#1568 — Claude default, Codex pluggable)", () => {
  it("defaults to claude and parses only known providers", () => {
    expect(DEFAULT_RUNTIME_PROVIDER).toBe("claude");
    expect(parseRuntimeProvider(undefined)).toBe("claude");
    expect(parseRuntimeProvider("")).toBe("claude");
    expect(parseRuntimeProvider("openai")).toBe("claude");
    expect(parseRuntimeProvider("claude")).toBe("claude");
    expect(parseRuntimeProvider("codex")).toBe("codex");
  });

  it("narrows untrusted values", () => {
    expect(isRuntimeProvider("claude")).toBe(true);
    expect(isRuntimeProvider("codex")).toBe(true);
    expect(isRuntimeProvider("demo")).toBe(false);
    expect(isRuntimeProvider(7)).toBe(false);
  });

  it("maps each provider onto its real harness", () => {
    expect(harnessForProvider("claude")).toBe("claude-code");
    expect(harnessForProvider("codex")).toBe("codex");
  });
});

describe("claude runtime status (#1568 — subscription primary, api-key fallback)", () => {
  const deps = (mode: "subscription" | "api_key" | "none") => ({
    resolveAuthMode: async () => mode,
  });

  it("reports authMode subscription when a Claude subscription token authenticates the run", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps("subscription")).status("w1", "m1");
    expect(status).toMatchObject({
      provider: "claude",
      connected: true,
      selectedHarness: "claude-code",
      runtimeAuth: "signed_in_subscription",
      authMode: "subscription",
      apiKeySatisfies: false,
      fallback: "none",
    });
  });

  it("reports authMode api_key when only the optional ANTHROPIC_API_KEY fallback exists", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps("api_key")).status("w1", "m1");
    expect(status).toMatchObject({
      connected: true,
      runtimeAuth: "api_key",
      authMode: "api_key",
      apiKeySatisfies: true,
    });
    expect(status.reason).toContain("fallback");
  });

  it("is disconnected with an owner-actionable subscription-first reason when no credential exists", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps("none")).status("w1", "m1");
    expect(status).toMatchObject({
      connected: false,
      runtimeAuth: "missing",
      authMode: null,
      apiKeySatisfies: false,
    });
    expect(status.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(status.reason).toContain("Connect Claude");
  });
});

describe("provider-dispatched runtime status (#1568)", () => {
  const codexStatus: CodexSubscriptionStatus = {
    connected: true,
    reason: "OpenAI ChatGPT subscription auth is ready for Codex agent runs.",
    selectedHarness: "codex",
    userAuthenticated: true,
    workspaceAuthenticated: true,
    runtimeAuth: "signed_in_subscription",
    fallback: "none",
    apiKeySatisfies: false,
  };

  it("projects the legacy codex shape field-for-field (+ subscription authMode when connected)", () => {
    expect(runtimeStatusFromCodex(codexStatus)).toEqual({
      ...codexStatus,
      provider: "codex",
      authMode: "subscription",
    });
    expect(runtimeStatusFromCodex({ ...codexStatus, connected: false }).authMode).toBeNull();
  });

  it("dispatches on the resolved provider", async () => {
    const claude = createClaudeRuntimeStatusProvider({
      resolveAuthMode: async () => "api_key",
    });
    const codex = { status: async () => codexStatus };

    const onClaude = await createRuntimeStatusProvider("claude", { claude, codex }).status("w", "m");
    expect(onClaude.provider).toBe("claude");
    expect(onClaude.selectedHarness).toBe("claude-code");

    const onCodex = await createRuntimeStatusProvider("codex", { claude, codex }).status("w", "m");
    expect(onCodex.provider).toBe("codex");
    expect(onCodex.selectedHarness).toBe("codex");
  });
});
