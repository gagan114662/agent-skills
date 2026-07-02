import { describe, it, expect } from "vitest";
import { decideAgentAuth, harnessRequiresAuth } from "../../src/runtime/agent-auth.js";

describe("decideAgentAuth (#68/#246/#1568 — subscription first, env API key fallback, per-tenant)", () => {
  it("uses the workspace subscription token when present", () => {
    const auth = decideAgentAuth({ subscriptionToken: "oauth-tok" });
    expect(auth).toEqual({
      mode: "subscription",
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    });
    // The subscription token is the only model credential — never an API key alongside it.
    expect(auth.secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("returns mode 'none' when the workspace has no token and the deployment has no env key", () => {
    expect(decideAgentAuth({ subscriptionToken: null })).toEqual({
      mode: "none",
      secrets: {},
    });
    expect(decideAgentAuth({ subscriptionToken: null, envApiKey: null })).toEqual({
      mode: "none",
      secrets: {},
    });
  });

  it("#1568: falls back to the deployment env ANTHROPIC_API_KEY when no subscription is connected", () => {
    expect(decideAgentAuth({ subscriptionToken: null, envApiKey: "sk-ant-env" })).toEqual({
      mode: "api_key",
      secrets: { ANTHROPIC_API_KEY: "sk-ant-env" },
    });
    // Blank env keys never count as auth.
    expect(decideAgentAuth({ subscriptionToken: null, envApiKey: "   " }).mode).toBe("none");
  });

  it("#1568: the workspace's own subscription token still WINS over the env key (per-tenant billing)", () => {
    const auth = decideAgentAuth({ subscriptionToken: "oauth-tok", envApiKey: "sk-ant-env" });
    expect(auth).toEqual({
      mode: "subscription",
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    });
    expect(auth.secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("treats blank/whitespace tokens as absent (no auth)", () => {
    expect(decideAgentAuth({ subscriptionToken: "   " }).mode).toBe("none");
    expect(decideAgentAuth({ subscriptionToken: "" }).mode).toBe("none");
  });

  it("#659: a present-but-MALFORMED token resolves to 'none' so the run is blocked up front, not mid-run", () => {
    // A bad paste with an embedded newline/space would otherwise be injected and crash the session.
    expect(decideAgentAuth({ subscriptionToken: "sk-ant\noat" }).mode).toBe("none");
    expect(decideAgentAuth({ subscriptionToken: "sk-ant oat" }).mode).toBe("none");
    // A well-formed token (even a short test literal) still authenticates.
    expect(decideAgentAuth({ subscriptionToken: "oauth-tok" }).mode).toBe("subscription");
  });
});

describe("harnessRequiresAuth (#68/#1270 — only claude-code needs per-workspace Claude auth)", () => {
  it("is false for the demo harness (no model spend, no auth needed)", () => {
    expect(harnessRequiresAuth("demo")).toBe(false);
  });

  it("is true only for claude-code; codex uses deployment subscription auth", () => {
    expect(harnessRequiresAuth("claude-code")).toBe(true);
    expect(harnessRequiresAuth("codex")).toBe(false);
  });
});
