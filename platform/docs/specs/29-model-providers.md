# Spec 29 — Multi-model & multi-provider selection + effort/Auto mode (#52)

## Goal
A **provider/model selection layer** the harness consumes: choose model + provider + effort (and an
optional Auto mode) **per session**, without changing the session lifecycle, streaming,
secret-redaction, or reaper, and without ever baking provider credentials into argv, config, or a
persisted row.

## Background
The real harness (#50, ADR-0027) spawns a fixed, server-owned `{ command, args }` per session and
injects the task as `AGENT_TASK`. Subagents (#59, ADR-0036) added a second, injection-safe seam —
`LaunchInput.harnessEnv`, extra **env** merged into the job alongside `AGENT_TASK`. Config layering
(#58, ADR-0035) added non-secret layered TOML; secrets stay on the #25 `SecretsResolver` path.

Conductor lets a workspace pick among frontier models across providers (Anthropic, OpenAI, **Bedrock**,
**Vertex**, custom URL) with effort/thinking levels and an **Auto mode** (Opus plans → Sonnet
implements). We have no model-selection layer: every session runs whatever single `ANTHROPIC_MODEL`
the deployment baked into argv.

## Key insight
Claude Code (our `claude-code` harness) already reads provider/model/effort selection from **env vars
it consumes natively**: `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `AWS_REGION`,
`MAX_THINKING_TOKENS`, and the model-alias overrides (`ANTHROPIC_DEFAULT_OPUS_MODEL`). So the
selection layer's job is **not** to build new argv — it is to **resolve a selection into a
secret-free env map** (plus the *names* of any secrets the provider needs), validated against the
tenant's policy, delivered through the **existing** `harnessEnv` seam. This reuses #59's
injection-safe path verbatim and adds **no new injection surface**.

## Design

### 1. Selection core — `runtime/model-selection.ts` (pure)
```ts
type ProviderKind = "anthropic" | "openai" | "bedrock" | "vertex" | "custom";
type EffortLevel  = "off" | "low" | "medium" | "high";
type SessionMode  = "single" | "auto";

interface SelectionInput {            // the per-session request (REST body / autonomy caller)
  provider?: string; model?: string; effort?: string; mode?: string;
}
interface ProviderConnection { baseUrl?: string; region?: string; projectId?: string }
interface ModelPolicy {               // resolved from config (#58) + env defaults
  defaultProvider: ProviderKind;
  defaultModel?: string;
  allowedProviders: ProviderKind[];   // a provider not in this set is rejected
  allowedModels?: string[];           // when set, the model must be a member (else rejected)
  defaultEffort: EffortLevel;
  defaultMode: SessionMode;
  auto?: { planModel: string; implementModel: string };
  providers: Partial<Record<ProviderKind, ProviderConnection>>;
  dataPrivacyMode: boolean;
}
interface ResolvedSelection {
  provider: ProviderKind; model: string; planModel?: string;   // planModel set only in auto mode
  effort: EffortLevel; mode: SessionMode;
  env: Record<string, string>;        // SECRET-FREE: flags, base URL, model(s), MAX_THINKING_TOKENS
  secretKeys: string[];               // NAMES only (e.g. ANTHROPIC_API_KEY); never values
}
function resolveSelection(input: SelectionInput, policy: ModelPolicy): ResolvedSelection; // throws SelectionError
class SelectionError extends Error {} // content-free; safe to surface as a 400
```
- **Provider → env flags:** anthropic → (optional `ANTHROPIC_BASE_URL`); openai/custom →
  `ANTHROPIC_BASE_URL=<connection.baseUrl>` (required; an Anthropic-compatible gateway); bedrock →
  `CLAUDE_CODE_USE_BEDROCK=1` (+ `AWS_REGION` if configured); vertex → `CLAUDE_CODE_USE_VERTEX=1`
  (+ `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` if configured).
- **Model:** `ANTHROPIC_MODEL=<model>`. **Effort:** off → no var; low/medium/high →
  `MAX_THINKING_TOKENS` ∈ {4096, 12288, 31999}. **Auto:** `model=implementModel`,
  `planModel` distinct, `ANTHROPIC_DEFAULT_OPUS_MODEL=<planModel>` so plan-mode (the Opus-class
  alias) runs the plan model while normal turns run the implement model — two models, one session.
- **secretKeys:** anthropic/openai/custom → `["ANTHROPIC_API_KEY"]`; **bedrock/vertex → `[]`** — cloud
  providers resolve credentials from the ambient credential chain (instance role / ADC) supplied as
  opaque env by the `SecretsResolver`, so **no API key is ever baked**.

### 2. Policy from config — `runtime/model-selection.ts` + `config/schema.ts`
A non-secret `models` block is added to `settingsSchema` / `ResolvedConfig` / `CONFIG_DEFAULTS`
(`defaultProvider`, `defaultModel`, `allowedProviders`, `allowedModels`, `defaultEffort`,
`defaultMode`, `auto`, `providers`). `modelPolicyFromConfig(config)` projects the resolved config into
a `ModelPolicy`. Secrets (API keys, AWS/GCP creds) are **forbidden** here, exactly like #57 mcpServers.

### 3. Harness — `runtime/harness.ts`
The `claude-code` model flag becomes **env-gated** (`${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`),
replacing the static `opts.model` argv bake, so the selected model is per-session overridable via env
and stays injection-safe (double-quoted env reference inside `bash -lc`, like `$AGENT_TASK`). Provider/
effort/auto vars need **no** command change — Claude Code reads them from process env natively.

### 4. Per-session wiring
- `env.ts`: stops baking `--model`; reads server-default selection (`AGENT_PROVIDER`, `ANTHROPIC_MODEL`,
  `AGENT_EFFORT`, `AGENT_MODE`) for the default policy.
- REST `POST /channels/:cid/agent-sessions`: accepts optional `provider`/`model`/`effort`/`mode`,
  resolves against `modelPolicyFromConfig(loadConfig(workspaceId))`, returns **400** on a policy
  violation (disallowed provider/model, missing Auto config, custom URL under data-privacy), threads
  `ResolvedSelection.env` through `LaunchInput.harnessEnv`, and persists the selection on the row.
- `agent_sessions` gains nullable `provider`, `model`, `effort`, `mode` columns (audit only — **never**
  a secret). `SessionStore.create` + `AgentSession` extend to carry them.

### 5. Egress gate (#58)
A provider that introduces an **external base URL** (custom / openai, or any provider with a configured
`baseUrl`) is an egress point: `resolveSelection` calls `egressAllowed({dataPrivacyMode})` and throws
`SelectionError` under data-privacy mode. Bedrock/Vertex (cloud-native, no external URL) are unaffected.

## Security
- **No secret ever in argv, config, or a row.** The resolved `env` is secret-free; only secret *names*
  travel in `secretKeys`. Values flow solely through `SecretsResolver` → runtime env and are redacted
  from output by the existing `makeRedactor`. The persisted columns hold provider/model/effort/mode —
  never a credential.
- **Bedrock/Vertex bake nothing.** `secretKeys=[]` + cloud SDK credential chain.
- **Injection-safe by construction.** Selection reaches the harness only as env (the #59 seam); the
  one new argv reference is a double-quoted env var.
- **Policy is the lock.** A managed-layer tenant can pin `allowedProviders`/`allowedModels`; a session
  cannot select outside it. Custom egress URLs are gated by data-privacy mode.

## In scope
- `model-selection.ts` (`resolveSelection`, `modelPolicyFromConfig`, `SelectionError`) + unit tests.
- `config/schema.ts` `models` block + defaults + tests.
- `harness.ts` env-gated model + `env.ts` default policy.
- `agent_sessions` columns + migration `0029_model_providers` + repo/store/type.
- REST body + validation + persistence + `harnessEnv` passthrough + integration test.
- Web: `AgentSessionSummary` fields + a `launchSession` client method + a compact `ModelSelector`.
- ADR-0029.

## Out of scope (follow-ups)
- Fine-grained cost/usage dashboards (#follow-up).
- Foundry / OIDC / per-model token-budget tuning beyond effort tiers.
- Structured per-turn model attribution in the #51 review UI.

## Acceptance (TDD)
- A session runs against a chosen model+provider (selection resolves → `harnessEnv` → row persisted).
- Bedrock/Vertex resolve credentials without baking secrets (`CLAUDE_CODE_USE_*` flag set,
  `secretKeys=[]`, no key in env).
- Effort level changes the invocation (effort → distinct `MAX_THINKING_TOKENS`; off → absent).
- Auto mode uses two distinct models in one session (`model` ≠ `planModel`; both present in env).
- A disallowed provider/model, missing Auto config, or custom URL under data-privacy → `SelectionError`
  (REST 400).
- Default behavior unchanged: no selection → no new env, demo/server defaults intact, existing tests green.
- ADR-0029 records the provider abstraction; demo video shows two providers/models + Auto mode.
