# ADR-0029: Multi-model & multi-provider selection + effort/Auto mode (#52)

- **Status:** Proposed (issue #52; awaiting @gagan114662 approval on the demo video)
- **Date:** 2026-06-09
- **Context issue:** [#52](https://github.com/gagan114662/agent-skills/issues/52) (Feature phase 4 —
  Real execution & Conductor parity)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (AgentRuntime / SessionManager / AgentJob +
  per-tenant `SecretsResolver`), [ADR-0027](0027-real-agent-harness.md) (the real Claude Code harness
  behind a config flag; task injected as `AGENT_TASK`, never argv), [ADR-0035](0035-config-layering.md)
  (layered non-secret config: env < user < repo < managed, per-tenant managed overrides, the
  data-privacy egress gate), [ADR-0036](0036-subagents.md) (the `LaunchInput.harnessEnv` seam — extra
  env merged into the job, injection-safe like `AGENT_TASK`)

## Context
Conductor lets a workspace pick among frontier models across providers (Anthropic, OpenAI, **Bedrock**,
**Vertex**, custom URL) with effort/thinking levels and an **Auto mode** (Opus plans → Sonnet
implements). We had no model-selection layer: every session ran the single `--model` the deployment
baked into the harness argv. #52 adds a **provider/model/effort selection layer the harness consumes**,
choosable **per session**, without weakening the secret-handling, injection-safety, or lifecycle
guarantees the harness (#50) and config (#58) already provide.

The pieces to build it already existed and should be **reused, not re-invented**: Claude Code (the
`claude-code` harness) reads provider/model/effort selection from **env vars it consumes natively**
(`ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`/`_USE_VERTEX`, `AWS_REGION`,
`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `MAX_THINKING_TOKENS`, `ANTHROPIC_DEFAULT_OPUS_MODEL`);
#59 added `harnessEnv`, an injection-safe per-session env seam; #58 added non-secret layered config and
the egress gate; #25's `SecretsResolver` already carries provider keys. So selection is not a new
execution engine — it is a **pure function from a request + a tenant policy to a secret-free env map**.

## Decisions

1. **Selection is a pure resolver, not a new harness.** `runtime/model-selection.ts` exposes
   `resolveSelection(input, policy): ResolvedSelection`. It validates the request against a
   {@link ModelPolicy} (projected from resolved config) and returns `{ provider, model, planModel?,
   effort, mode, env, secretKeys }`. `env` is **secret-free** (provider flags, base URL, model name(s),
   `MAX_THINKING_TOKENS`); `secretKeys` lists only the **names** of secrets the provider needs. The
   resolver is fully unit-tested and has no I/O.

2. **Selection reaches the harness as env, never argv — the #59 seam, verbatim.** The route threads
   `ResolvedSelection.env` through `LaunchInput.harnessEnv`; the SessionManager merges it into the job
   env alongside `AGENT_TASK`. The only harness command change is making the model flag **env-gated**
   (`${ANTHROPIC_MODEL:+--model "$ANTHROPIC_MODEL"}`) — a double-quoted env reference inside `bash -lc`,
   injection-safe exactly like `$AGENT_TASK`, replacing the static `opts.model` argv bake. Provider/
   effort/Auto vars need no command change: Claude Code reads them from process env natively. This adds
   **no new injection surface**.

3. **Bedrock/Vertex bake nothing.** Their resolver branch sets only the `CLAUDE_CODE_USE_*` flag
   (+ region/project) and returns `secretKeys: []`. Credentials come from the cloud SDK credential
   chain (AWS instance role / Google ADC), supplied as opaque env by the `SecretsResolver` — never an
   API key in argv, config, or a row. This is the "resolve credentials without baking secrets"
   guarantee, proven by an integration test that runs Bedrock with **no** secret configured and asserts
   no API key reached the agent.

4. **Auto mode is two distinct models in one session.** When `mode='auto'`, the resolver requires a
   configured `auto: { planModel, implementModel }` pair, sets `ANTHROPIC_MODEL` to the implement model
   and `ANTHROPIC_DEFAULT_OPUS_MODEL` to the (distinct) plan model — so plan-mode turns (the Opus-class
   alias) run the plan model while normal turns run the implement model. Both models travel in one env
   map for one session; the integration test asserts both are present and distinct.

5. **Policy is the lock; secrets stay off config.** A non-secret `models` block is added to the #58
   schema (`defaultProvider`, `defaultModel`, `allowedProviders`, `allowedModels`, `defaultEffort`,
   `defaultMode`, `auto`, per-provider `providers` connection details). A managed-layer tenant pins
   `allowedProviders`/`allowedModels`; the resolver rejects any out-of-policy selection with a
   content-free `SelectionError` (REST 400). Provider **credentials are forbidden** in config — the
   schema admits only the keys above, exactly like #57 `mcpServers.env` (names, never values).

6. **Custom/external URLs honor the #58 egress gate.** A provider that introduces an external base URL
   (custom/openai, or any provider with a configured `baseUrl`) is an egress point: the resolver calls
   `egressAllowed({dataPrivacyMode})` and refuses under data-privacy mode. Cloud-native Bedrock/Vertex
   (no external URL) are unaffected.

7. **The selection is persisted (non-secret) for audit + the review UI.** `agent_sessions` gains
   nullable `provider`/`model`/`effort`/`mode` columns (CHECK-constrained to the known vocabularies);
   the REST 202 echoes them and the web surfaces a per-session badge + a `ModelSelector` launch control.
   The columns hold selection metadata only — **never** a credential.

## Consequences
- A session can run against any allowed provider/model with a chosen effort tier or in Auto mode,
  proven end-to-end by an integration test (real Postgres + LocalRuntime) whose harness echoes the
  selection env it received: chosen model + thinking budget, the Bedrock flag with no baked key, and
  Auto's two distinct models — plus a 400 for an out-of-policy provider.
- Default behavior is unchanged: with no selection requested and no tenant default model, the route
  adds no env and the harness command is byte-for-byte #50/#59's (the env-gated `--model` simply
  vanishes when `ANTHROPIC_MODEL` is unset). All 312 server unit tests + the #25/#58/#59 integration
  tests stay green.
- One new module (`model-selection.ts`), one config block, one migration (`0029`), four nullable
  columns, an env-gated harness flag, a REST body extension, and a thin web surface. No new runtime, no
  new auth, no new secret path.

## Security
- **No secret in argv, config, or a row.** The resolved `env` is secret-free; only secret *names* ride
  in `secretKeys`. Values flow solely through the #25 `SecretsResolver` and are redacted from output by
  the existing `makeRedactor`. The persisted columns are selection metadata, never a credential.
- **Bedrock/Vertex bake nothing** — `secretKeys: []` + the cloud credential chain.
- **Injection-safe by construction** — selection is delivered only as env (the #59 seam); the one new
  argv token is a double-quoted env reference. Model strings are validated to `/^[A-Za-z0-9._:\-/]+$/`
  at resolve time (defense in depth), so a hostile model value is rejected, never interpolated.
- **Policy lock + egress gate** — managed `allowedProviders`/`allowedModels` cannot be widened by a
  lower layer; custom/external URLs are refused under data-privacy mode.
- **Tenant isolation** — the policy is resolved per workspace (`loadConfig(workspaceId)`); the launch
  route keeps the #25 IDOR/capability guards unchanged.

## Alternatives considered
- **Build provider/model/effort as new argv flags on the harness command:** rejected — Claude Code
  reads them from env natively, so new argv would be redundant *and* would reintroduce an interpolation
  surface for free-form values (URLs, regions). Env (the `AGENT_TASK`/`harnessEnv` contract) is
  injection-safe and keeps `harnessSpec` selection-agnostic.
- **Store provider credentials in the layered config:** rejected — config is non-secret by ADR-0035;
  credentials stay on the `SecretsResolver` path. Config carries only connection *shape* (provider,
  base URL, region, project) and names.
- **Bake AWS/GCP keys for Bedrock/Vertex:** rejected — the cloud SDK credential chain (instance role /
  ADC) is the intended, secret-free path; baking keys would violate the "no secret in a row/argv"
  guarantee for no benefit.
- **A standalone per-session `model` column with no policy:** rejected — without an allow-list a tenant
  cannot constrain spend/providers; the managed-layer lock is the point.
- **Implement Auto mode as two chained sessions:** deferred — a single session exposing both models via
  env (plan alias + implement default) matches Conductor's "Opus plans → Sonnet implements" with no
  lifecycle change; true multi-session orchestration layers on the #17 autonomy engine later.

## Follow-ups (deferred)
- Fine-grained cost/usage dashboards per provider/model (the #52 out-of-scope follow-up).
- Foundry / OIDC providers and custom-URL auth headers beyond a single key.
- Per-model thinking-budget tuning beyond the three effort tiers.
- Structured per-turn model attribution in the #51 review UI (which model produced which turn).
- A full session-launch form in the web client wired to `api.review.launchSession` (the control +
  client method ship now; the generic launch surface is additive).
- Thread the selection env into the SandboxRuntime backend (the `harnessEnv` seam already carries it).
