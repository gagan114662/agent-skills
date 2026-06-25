/**
 * Multi-model / multi-provider selection (#52, ADR-0029).
 *
 * The selection layer the harness consumes: it turns a per-session *request* (which provider, model,
 * effort, and whether to run Auto mode) into a **secret-free env map** that Claude Code reads
 * natively — plus the *names* of any secrets the chosen provider needs. The env is delivered through
 * the established injection-safe seam (`LaunchInput.harnessEnv`, #59), so selecting a model adds **no
 * new injection surface** and no command-string change beyond the env-gated `--model` flag.
 *
 * Security invariants:
 *   - The resolved `env` is **secret-free**: provider flags, base URL, model name(s), thinking budget.
 *     Credentials never appear here — only their NAMES travel in `secretKeys`, resolved through the
 *     #25 `SecretsResolver` and redacted from output.
 *   - **Bedrock/Vertex bake nothing** (`secretKeys: []`): the cloud SDK credential chain (instance
 *     role / ADC) supplies creds as opaque env.
 *   - A request is validated against the tenant's {@link ModelPolicy}: a provider/model outside the
 *     allow-list, a missing Auto pair, or a custom egress URL under data-privacy mode is rejected.
 */
import { egressAllowed } from "../config/egress.js";
import {
  providerKinds,
  effortLevels,
  sessionModes,
  type EffortLevel,
  type ProviderConnection,
  type ProviderKind,
  type ResolvedConfig,
  type SessionMode,
} from "../config/schema.js";

export type { EffortLevel, ProviderKind, SessionMode } from "../config/schema.js";

/** A per-session selection request (REST body / autonomy caller). All fields are untrusted strings. */
export interface SelectionInput {
  provider?: string;
  model?: string;
  effort?: string;
  mode?: string;
}

/** The tenant policy a request is validated against (projected from resolved config + env defaults). */
export interface ModelPolicy {
  defaultProvider: ProviderKind;
  defaultModel?: string;
  /** Providers the tenant permits; a request outside this set is rejected. */
  allowedProviders: ProviderKind[];
  /** When set, the resolved model(s) must be members; when undefined, any valid model string passes. */
  allowedModels?: string[];
  defaultEffort: EffortLevel;
  defaultMode: SessionMode;
  /** The Auto-mode model pair (Opus plans → Sonnet implements); required to launch in `auto` mode. */
  auto?: { planModel: string; implementModel: string };
  /** Non-secret per-provider connection details (base URL / region / project). */
  providers: Partial<Record<ProviderKind, ProviderConnection>>;
  /** #58 data-privacy mode: when on, providers with an external base URL are refused. */
  dataPrivacyMode: boolean;
}

/** The validated outcome the SessionManager threads into `harnessEnv` + persists on the row. */
export interface ResolvedSelection {
  provider: ProviderKind;
  model: string;
  /** Set only in Auto mode — the (distinct) model used for planning turns. */
  planModel?: string;
  effort: EffortLevel;
  mode: SessionMode;
  /** SECRET-FREE env for the harness: provider flags, base URL, model(s), thinking budget. */
  env: Record<string, string>;
  /** NAMES of secrets the provider needs (e.g. `ANTHROPIC_API_KEY`); empty for cloud-cred providers. */
  secretKeys: string[];
}

/**
 * The explicit receipt returned when the owner asks for a ChatGPT/Codex subscription-backed OpenAI run
 * but this deployment has no permitted machine-access bridge. This is intentionally separate from the
 * OpenAI API/gateway path: an API key can run a provider, but it does not prove the owner's subscription
 * powered the agent.
 */
export interface SubscriptionBackedModelBlockReceipt {
  provider: "openai-subscription";
  providerFamily: "openai";
  model: string;
  capability: "codex-seat-backed-agent-execution";
  entitlementSource: "chatgpt-codex-subscription";
  status: "blocked";
  reason: "no_permitted_subscription_bridge";
  fallback: "none";
  apiKeySatisfies: false;
  message: string;
}

/** Thrown when a request violates policy. Content-free + safe to surface as an HTTP 400. */
export class SelectionError extends Error {
  constructor(
    message: string,
    readonly receipt?: SubscriptionBackedModelBlockReceipt,
  ) {
    super(message);
    this.name = "SelectionError";
  }
}

/** Thinking-token budget per effort tier; `off` omits the var entirely (unchanged behavior). */
const EFFORT_THINKING_TOKENS: Record<Exclude<EffortLevel, "off">, number> = {
  low: 4096,
  medium: 12288,
  high: 31999,
};

/** A model name must be a plain identifier — no shell/path-hostile characters (defense in depth). */
const MODEL_RE = /^[A-Za-z0-9._:\-/]+$/;

function isProvider(v: string): v is ProviderKind {
  return (providerKinds as readonly string[]).includes(v);
}
function isEffort(v: string): v is EffortLevel {
  return (effortLevels as readonly string[]).includes(v);
}
function isMode(v: string): v is SessionMode {
  return (sessionModes as readonly string[]).includes(v);
}

function assertModelAllowed(model: string, policy: ModelPolicy): void {
  if (!MODEL_RE.test(model)) throw new SelectionError("model contains invalid characters");
  if (policy.allowedModels && !policy.allowedModels.includes(model)) {
    throw new SelectionError("model is not permitted by policy");
  }
}

/** Providers whose connection introduces an off-platform base URL (an egress point). */
function usesExternalUrl(provider: ProviderKind, conn: ProviderConnection | undefined): boolean {
  if (provider === "custom" || provider === "openai") return true;
  return Boolean(conn?.baseUrl);
}

function blockedOpenAISubscriptionReceipt(model: string): SubscriptionBackedModelBlockReceipt {
  return {
    provider: "openai-subscription",
    providerFamily: "openai",
    model,
    capability: "codex-seat-backed-agent-execution",
    entitlementSource: "chatgpt-codex-subscription",
    status: "blocked",
    reason: "no_permitted_subscription_bridge",
    fallback: "none",
    apiKeySatisfies: false,
    message:
      "No permitted ChatGPT/Codex subscription-backed machine-access bridge is configured; OpenAI API keys are a separate billing path and do not satisfy this provider.",
  };
}

/** Provider → secret-free env flags. Credentials are NOT touched here (only `secretKeys` names them). */
function providerEnv(
  provider: ProviderKind,
  conn: ProviderConnection | undefined,
): { env: Record<string, string>; secretKeys: string[] } {
  const env: Record<string, string> = {};
  switch (provider) {
    case "anthropic":
      if (conn?.baseUrl) env.ANTHROPIC_BASE_URL = conn.baseUrl;
      return { env, secretKeys: ["ANTHROPIC_API_KEY"] };
    case "openai":
    case "custom": {
      const baseUrl = conn?.baseUrl;
      if (!baseUrl) throw new SelectionError(`${provider} provider requires a configured baseUrl`);
      env.ANTHROPIC_BASE_URL = baseUrl;
      return { env, secretKeys: ["ANTHROPIC_API_KEY"] };
    }
    case "openai-subscription":
      throw new SelectionError(
        "OpenAI subscription-backed provider is unavailable: no permitted ChatGPT/Codex machine-access bridge is configured",
        blockedOpenAISubscriptionReceipt("unknown"),
      );
    case "bedrock":
      env.CLAUDE_CODE_USE_BEDROCK = "1";
      if (conn?.region) env.AWS_REGION = conn.region;
      // No baked secret: AWS credential chain (instance role / ADC) supplies creds as opaque env.
      return { env, secretKeys: [] };
    case "vertex":
      env.CLAUDE_CODE_USE_VERTEX = "1";
      if (conn?.projectId) env.ANTHROPIC_VERTEX_PROJECT_ID = conn.projectId;
      if (conn?.region) env.CLOUD_ML_REGION = conn.region;
      // No baked secret: Google Application Default Credentials supply creds as opaque env.
      return { env, secretKeys: [] };
  }
}

/**
 * Resolve + validate a per-session selection against a tenant policy. Pure and injection-safe: it
 * returns a secret-free env map (for the harness) and the names of any secrets the provider needs.
 * Throws {@link SelectionError} on any policy violation (safe to map to a 400).
 */
export function resolveSelection(input: SelectionInput, policy: ModelPolicy): ResolvedSelection {
  // --- provider ---
  const providerRaw = input.provider ?? policy.defaultProvider;
  if (!isProvider(providerRaw)) throw new SelectionError("unknown provider");
  if (!policy.allowedProviders.includes(providerRaw)) {
    throw new SelectionError("provider is not permitted by policy");
  }
  const provider = providerRaw;
  const conn = policy.providers[provider];

  // --- egress gate (#58): an external base URL may not be used under data-privacy mode ---
  if (usesExternalUrl(provider, conn) && !egressAllowed({ dataPrivacyMode: policy.dataPrivacyMode })) {
    throw new SelectionError("provider egress is disabled under data-privacy mode");
  }

  // --- mode + model(s) ---
  const modeRaw = input.mode ?? policy.defaultMode;
  if (!isMode(modeRaw)) throw new SelectionError("unknown mode");
  const mode = modeRaw;

  let model: string;
  let planModel: string | undefined;
  if (mode === "auto") {
    if (!policy.auto) throw new SelectionError("Auto mode requires a configured plan/implement model pair");
    planModel = policy.auto.planModel;
    model = policy.auto.implementModel;
    assertModelAllowed(planModel, policy);
    assertModelAllowed(model, policy);
  } else {
    const chosen = input.model ?? policy.defaultModel;
    if (!chosen) throw new SelectionError("a model must be selected");
    assertModelAllowed(chosen, policy);
    model = chosen;
  }

  // --- effort ---
  const effortRaw = input.effort ?? policy.defaultEffort;
  if (!isEffort(effortRaw)) throw new SelectionError("unknown effort level");
  const effort = effortRaw;

  if (provider === "openai-subscription") {
    throw new SelectionError(
      "OpenAI subscription-backed provider is unavailable: no permitted ChatGPT/Codex machine-access bridge is configured",
      blockedOpenAISubscriptionReceipt(model),
    );
  }

  // --- assemble the secret-free env Claude Code reads natively ---
  const { env: provEnv, secretKeys } = providerEnv(provider, conn);
  const env: Record<string, string> = { ...provEnv, ANTHROPIC_MODEL: model };
  if (planModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = planModel; // plan-mode (Opus alias) → plan model
  if (effort !== "off") env.MAX_THINKING_TOKENS = String(EFFORT_THINKING_TOKENS[effort]);

  return { provider, model, planModel, effort, mode, env, secretKeys };
}

/** Project the resolved config (#58) into a {@link ModelPolicy}, applying hard defaults. */
export function modelPolicyFromConfig(config: ResolvedConfig): ModelPolicy {
  const m = config.models ?? {};
  const defaultProvider = m.defaultProvider ?? "anthropic";
  return {
    defaultProvider,
    defaultModel: m.defaultModel,
    // Default allow-list is just the default provider — a deployment opts into more explicitly.
    allowedProviders: m.allowedProviders ?? [defaultProvider],
    allowedModels: m.allowedModels,
    defaultEffort: m.defaultEffort ?? "off",
    defaultMode: m.defaultMode ?? "single",
    auto: m.auto,
    providers: (m.providers ?? {}) as Partial<Record<ProviderKind, ProviderConnection>>,
    dataPrivacyMode: config.dataPrivacyMode,
  };
}
