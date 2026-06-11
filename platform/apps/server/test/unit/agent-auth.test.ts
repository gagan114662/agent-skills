import { describe, it, expect } from "vitest";
import { decideAgentAuth, harnessRequiresAuth } from "../../src/runtime/agent-auth.js";

describe("decideAgentAuth (#68 — subscription-first, per-tenant)", () => {
  it("uses the workspace subscription token when present", () => {
    const auth = decideAgentAuth({ subscriptionToken: "oauth-tok", platformKey: null });
    expect(auth).toEqual({
      mode: "subscription",
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    });
  });

  it("prefers the subscription token even when a platform key is also configured", () => {
    const auth = decideAgentAuth({ subscriptionToken: "oauth-tok", platformKey: "sk-platform" });
    expect(auth.mode).toBe("subscription");
    expect(auth.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" });
    // The owner's subscription must never leak the platform key alongside it.
    expect(auth.secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("falls back to the platform key only when the workspace has no token", () => {
    const auth = decideAgentAuth({ subscriptionToken: null, platformKey: "sk-platform" });
    expect(auth).toEqual({
      mode: "platform",
      secrets: { ANTHROPIC_API_KEY: "sk-platform" },
    });
  });

  it("returns mode 'none' with no secrets when neither is configured", () => {
    expect(decideAgentAuth({ subscriptionToken: null, platformKey: null })).toEqual({
      mode: "none",
      secrets: {},
    });
  });

  it("treats blank/whitespace tokens as absent (no auth)", () => {
    expect(decideAgentAuth({ subscriptionToken: "   ", platformKey: null }).mode).toBe("none");
    expect(decideAgentAuth({ subscriptionToken: "", platformKey: "  " }).mode).toBe("none");
    // a blank subscription token falls through to a real platform key
    expect(decideAgentAuth({ subscriptionToken: "  ", platformKey: "sk-platform" }).mode).toBe(
      "platform",
    );
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
