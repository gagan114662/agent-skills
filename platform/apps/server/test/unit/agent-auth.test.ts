import { describe, it, expect } from "vitest";
import { decideAgentAuth, harnessRequiresAuth } from "../../src/runtime/agent-auth.js";

describe("decideAgentAuth (#68/#246 — subscription-ONLY, per-tenant)", () => {
  it("uses the workspace subscription token when present", () => {
    const auth = decideAgentAuth({ subscriptionToken: "oauth-tok" });
    expect(auth).toEqual({
      mode: "subscription",
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    });
    // The subscription token is the only model credential — never an API key alongside it.
    expect(auth.secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("#246: returns mode 'none' (NO API-key fallback) when the workspace has no token", () => {
    expect(decideAgentAuth({ subscriptionToken: null })).toEqual({
      mode: "none",
      secrets: {},
    });
  });

  it("treats blank/whitespace tokens as absent (no auth) — never an API key", () => {
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

describe("harnessRequiresAuth (#68 — only real harnesses need model auth)", () => {
  it("is false for the demo harness (no model spend, no auth needed)", () => {
    expect(harnessRequiresAuth("demo")).toBe(false);
  });

  it("is true for real coding harnesses", () => {
    expect(harnessRequiresAuth("claude-code")).toBe(true);
    expect(harnessRequiresAuth("codex")).toBe(true);
  });
});
