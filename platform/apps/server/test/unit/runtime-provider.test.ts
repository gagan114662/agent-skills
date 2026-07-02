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

describe("claude runtime status (#1568)", () => {
  const deps = (subscription: boolean, apiKey: boolean) => ({
    hasWorkspaceSubscription: async () => subscription,
    hasEnvApiKey: () => apiKey,
  });

  it("is connected via the workspace subscription first (per-tenant billing wins)", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps(true, true)).status("w1", "m1");
    expect(status).toMatchObject({
      provider: "claude",
      connected: true,
      selectedHarness: "claude-code",
      runtimeAuth: "signed_in_subscription",
      apiKeySatisfies: false,
      fallback: "none",
    });
  });

  it("is connected via the deployment env ANTHROPIC_API_KEY when no subscription is on file", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps(false, true)).status("w1", "m1");
    expect(status).toMatchObject({
      connected: true,
      runtimeAuth: "api_key",
      apiKeySatisfies: true,
    });
    expect(status.reason).toContain("Anthropic API key");
  });

  it("is disconnected with an owner-actionable reason when neither credential exists", async () => {
    const status = await createClaudeRuntimeStatusProvider(deps(false, false)).status("w1", "m1");
    expect(status).toMatchObject({ connected: false, runtimeAuth: "missing", apiKeySatisfies: false });
    expect(status.reason).toContain("ANTHROPIC_API_KEY");
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

  it("projects the legacy codex shape field-for-field", () => {
    expect(runtimeStatusFromCodex(codexStatus)).toEqual({ ...codexStatus, provider: "codex" });
  });

  it("dispatches on the resolved provider", async () => {
    const claude = createClaudeRuntimeStatusProvider({
      hasWorkspaceSubscription: async () => false,
      hasEnvApiKey: () => true,
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
