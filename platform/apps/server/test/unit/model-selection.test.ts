import { describe, expect, it } from "vitest";
import {
  resolveSelection,
  modelPolicyFromConfig,
  SelectionError,
  type ModelPolicy,
} from "../../src/runtime/model-selection.js";
import { CONFIG_DEFAULTS, type ResolvedConfig } from "../../src/config/schema.js";

/** A permissive base policy for the happy-path tests; individual tests tighten it. */
function policy(over: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    allowedProviders: ["anthropic", "openai", "openai-subscription", "bedrock", "vertex", "custom"],
    allowedModels: undefined,
    defaultEffort: "off",
    defaultMode: "single",
    auto: { planModel: "claude-opus-4-8", implementModel: "claude-sonnet-4-6" },
    providers: {
      openai: { baseUrl: "https://gw.example.com/v1" },
      custom: { baseUrl: "https://llm.internal.example/v1" },
      bedrock: { region: "us-east-1" },
      vertex: { projectId: "proj-123", region: "us-central1" },
    },
    dataPrivacyMode: false,
    ...over,
  };
}

describe("model selection (#52)", () => {
  it("resolves the default provider + model when nothing is requested", () => {
    const s = resolveSelection({}, policy());
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.mode).toBe("single");
    expect(s.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(s.planModel).toBeUndefined();
  });

  it("a session runs against a chosen model + provider", () => {
    const s = resolveSelection({ provider: "anthropic", model: "claude-opus-4-8" }, policy());
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.env.ANTHROPIC_MODEL).toBe("claude-opus-4-8");
    // Anthropic needs an API key — by NAME only, never a value.
    expect(s.secretKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(Object.values(s.env)).not.toContain("sk-secret");
  });

  it("Bedrock resolves credentials without baking secrets", () => {
    const s = resolveSelection({ provider: "bedrock", model: "anthropic.claude-3-5-sonnet" }, policy());
    expect(s.env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(s.env.AWS_REGION).toBe("us-east-1");
    // No API key is baked: the AWS credential chain (instance role / ADC) supplies creds as opaque env.
    expect(s.secretKeys).toEqual([]);
    expect(s.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("Vertex sets the use-vertex flag + project/region without baking secrets", () => {
    const s = resolveSelection({ provider: "vertex", model: "claude-sonnet-4-6" }, policy());
    expect(s.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(s.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("proj-123");
    expect(s.env.CLOUD_ML_REGION).toBe("us-central1");
    expect(s.secretKeys).toEqual([]);
  });

  it("custom and OpenAI gateway providers route through a Claude-compatible API-key path", () => {
    const s = resolveSelection({ provider: "custom", model: "my-model" }, policy());
    expect(s.env.ANTHROPIC_BASE_URL).toBe("https://llm.internal.example/v1");
    expect(s.secretKeys).toEqual(["ANTHROPIC_API_KEY"]);

    const openaiGateway = resolveSelection({ provider: "openai", model: "gpt-4.1" }, policy());
    expect(openaiGateway.env.ANTHROPIC_BASE_URL).toBe("https://gw.example.com/v1");
    expect(openaiGateway.secretKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("blocks the ChatGPT/Codex subscription-backed OpenAI provider until a permitted bridge exists", () => {
    try {
      resolveSelection({ provider: "openai-subscription", model: "gpt-5.5-codex" }, policy());
      throw new Error("expected openai-subscription to be blocked");
    } catch (err) {
      expect(err).toBeInstanceOf(SelectionError);
      const receipt = (err as SelectionError).receipt;
      expect(receipt).toMatchObject({
        provider: "openai-subscription",
        providerFamily: "openai",
        model: "gpt-5.5-codex",
        capability: "codex-seat-backed-agent-execution",
        entitlementSource: "chatgpt-codex-subscription",
        status: "blocked",
        reason: "no_permitted_subscription_bridge",
        apiKeySatisfies: false,
        fallback: "none",
      });
    }
  });

  it("does not treat API-key-only OpenAI gateway config as subscription-backed access", () => {
    const apiKeyGateway = resolveSelection({ provider: "openai", model: "gpt-4.1" }, policy());
    expect(apiKeyGateway.provider).toBe("openai");
    expect(apiKeyGateway.secretKeys).toEqual(["ANTHROPIC_API_KEY"]);

    expect(() =>
      resolveSelection({ provider: "openai-subscription", model: "gpt-5.5-codex" }, policy()),
    ).toThrow(SelectionError);
  });

  it("effort level changes the invocation (distinct thinking budgets)", () => {
    expect(resolveSelection({ effort: "off" }, policy()).env.MAX_THINKING_TOKENS).toBeUndefined();
    const low = resolveSelection({ effort: "low" }, policy()).env.MAX_THINKING_TOKENS;
    const med = resolveSelection({ effort: "medium" }, policy()).env.MAX_THINKING_TOKENS;
    const high = resolveSelection({ effort: "high" }, policy()).env.MAX_THINKING_TOKENS;
    expect(Number(low)).toBeGreaterThan(0);
    expect(Number(med)).toBeGreaterThan(Number(low));
    expect(Number(high)).toBeGreaterThan(Number(med));
  });

  it("Auto mode uses two distinct models in one session", () => {
    const s = resolveSelection({ mode: "auto" }, policy());
    expect(s.mode).toBe("auto");
    expect(s.planModel).toBe("claude-opus-4-8");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.planModel).not.toBe(s.model);
    // Both models are present in the env handed to the harness.
    expect(s.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-8");
  });

  it("rejects a provider outside the allow-list", () => {
    expect(() => resolveSelection({ provider: "bedrock" }, policy({ allowedProviders: ["anthropic"] }))).toThrow(
      SelectionError,
    );
  });

  it("rejects an unknown provider value", () => {
    expect(() => resolveSelection({ provider: "skynet" }, policy())).toThrow(SelectionError);
  });

  it("rejects a model outside an explicit allow-list", () => {
    const p = policy({ allowedModels: ["claude-sonnet-4-6", "claude-opus-4-8"] });
    expect(() => resolveSelection({ model: "gpt-9" }, p)).toThrow(SelectionError);
    expect(resolveSelection({ model: "claude-opus-4-8" }, p).model).toBe("claude-opus-4-8");
  });

  it("rejects a model with shell/path-hostile characters (defense in depth)", () => {
    expect(() => resolveSelection({ model: "x'; rm -rf /; '" }, policy())).toThrow(SelectionError);
  });

  it("rejects Auto mode when no auto model pair is configured", () => {
    expect(() => resolveSelection({ mode: "auto" }, policy({ auto: undefined }))).toThrow(SelectionError);
  });

  it("rejects a custom/external base URL under data-privacy mode (egress gate)", () => {
    expect(() => resolveSelection({ provider: "custom" }, policy({ dataPrivacyMode: true }))).toThrow(
      SelectionError,
    );
    // ...but a cloud-native provider with no external URL is still allowed under data-privacy.
    expect(resolveSelection({ provider: "bedrock", model: "m" }, policy({ dataPrivacyMode: true })).env
      .CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("requires a base URL for custom/openai providers", () => {
    expect(() =>
      resolveSelection({ provider: "custom" }, policy({ providers: {} })),
    ).toThrow(SelectionError);
  });

  it("requires a model (no default, none requested)", () => {
    expect(() => resolveSelection({}, policy({ defaultModel: undefined }))).toThrow(SelectionError);
  });

  it("rejects an unknown effort/mode value", () => {
    expect(() => resolveSelection({ effort: "ludicrous" }, policy())).toThrow(SelectionError);
    expect(() => resolveSelection({ mode: "swarm" }, policy())).toThrow(SelectionError);
  });
});

describe("modelPolicyFromConfig (#52)", () => {
  it("projects the resolved config into a policy with defaults", () => {
    const p = modelPolicyFromConfig(CONFIG_DEFAULTS);
    expect(p.defaultProvider).toBe("anthropic");
    expect(p.allowedProviders).toContain("anthropic");
    expect(p.defaultEffort).toBe("off");
    expect(p.defaultMode).toBe("single");
    expect(p.dataPrivacyMode).toBe(false);
  });

  it("carries a tenant's allow-list, auto pair, and provider connections through", () => {
    const config: ResolvedConfig = {
      ...CONFIG_DEFAULTS,
      dataPrivacyMode: true,
      models: {
        defaultProvider: "bedrock",
        defaultModel: "anthropic.claude-3-5-sonnet",
        allowedProviders: ["bedrock", "anthropic"],
        allowedModels: ["anthropic.claude-3-5-sonnet"],
        defaultEffort: "high",
        defaultMode: "auto",
        auto: { planModel: "claude-opus-4-8", implementModel: "claude-sonnet-4-6" },
        providers: { bedrock: { region: "eu-west-1" } },
      },
    };
    const p = modelPolicyFromConfig(config);
    expect(p.defaultProvider).toBe("bedrock");
    expect(p.allowedProviders).toEqual(["bedrock", "anthropic"]);
    expect(p.allowedModels).toEqual(["anthropic.claude-3-5-sonnet"]);
    expect(p.defaultEffort).toBe("high");
    expect(p.auto?.planModel).toBe("claude-opus-4-8");
    expect(p.providers.bedrock?.region).toBe("eu-west-1");
    expect(p.dataPrivacyMode).toBe(true);
  });
});
