import { z } from "zod";

/**
 * File-backed config schema (#58, ADR-0035). These are the **non-secret** settings a deployment can
 * set in layered TOML (user + repo scope) on top of env, with a managed/enterprise override on top.
 *
 * Secrets NEVER live here — they stay on the #25 `SecretsResolver`/`AGENT_SECRETS` path. The schema
 * admits only the keys below; everything else is stripped (forward-compatible) by zod's default
 * object behavior, so an unknown/secret-looking key in a layer can never reach `ResolvedConfig`.
 *
 * Every field is optional because a single *layer* is a partial — `mergeLayers` applies defaults.
 */
/** A project slash command (#57): a named prompt template runnable in a session. */
export const slashCommandSchema = z.object({
  /** Optional human description (exported as the command doc header). */
  description: z.string().optional(),
  /** The prompt template; `{{args}}` is replaced with the caller's args at expansion time. */
  prompt: z.string(),
});

/**
 * A canonical MCP server entry (#57) — the source of truth synced to each harness's format. Carries
 * only **non-secret** fields: `env` is a list of variable NAMES the harness should pass through, so a
 * secret value is never stored in config nor written into an exported artifact (placeholders only).
 */
export const mcpServerSchema = z.object({
  /** stdio transport: the command to spawn. */
  command: z.string().optional(),
  /** Args for the stdio command. */
  args: z.array(z.string()).optional(),
  /** http/sse transport: the server URL (mutually exclusive with `command` in practice). */
  url: z.string().optional(),
  /** Names of env vars the harness should pass to the server (values stay on the secrets path). */
  env: z.array(z.string()).optional(),
});

/**
 * The run command for a session's app (#56) — declared in **trusted** config (repo/managed scope),
 * never supplied by a request, so the Run tab can never become arbitrary RCE beyond what the
 * deployment chose to make runnable (the same trust boundary as the #27 harness command).
 */
export const runSchema = z.object({
  /** Shell command that starts the app's dev server (run via `sh -c` in the session's worktree). */
  command: z.string(),
  /** Explicit preview port; when set, detection is skipped and this port is used immediately. */
  port: z.number().int().positive().max(65535).optional(),
  /** Optional regex (string) whose first capture group is the bound port (or full url) in output. */
  readyPattern: z.string().optional(),
});

/**
 * Deploy-to-live-URL settings (#73) — declared in **trusted** config (repo/managed scope), never
 * supplied by a request, so deploy can never become arbitrary RCE/unbounded scale (the same trust
 * boundary as the #56 run command). Provider **credentials never live here** — they stay on the #25
 * `SecretsResolver` path; `env` lists only variable NAMES to pass into the build (the #57 convention).
 * A deployment with no `deploy` section has opted out (the Deploy tab → 409).
 */
export const deploySchema = z.object({
  /** Hosting backend (`dryrun` default — no spend | `vercel`). Mirrors the env-level DEPLOY_PROVIDER. */
  provider: z.enum(["dryrun", "vercel"]).optional(),
  /** Optional explicit deploy/build command (overrides framework detection). */
  command: z.string().optional(),
  /** Override the detected framework (`next`/`vite`/`cra`/`astro`/`node`/`static`). */
  framework: z.string().optional(),
  /** Override the detected build command. */
  buildCommand: z.string().optional(),
  /** Override the detected build output directory. */
  outputDir: z.string().optional(),
  /** Names of env vars to pass into the build (values stay on the secrets path). */
  env: z.array(z.string()).optional(),
  /** Upper bound for one-click scaling (instance count). Defaults to 1 when unset. */
  maxInstances: z.number().int().positive().max(100).optional(),
});

/**
 * Stripe revenue-rails settings (#98, ADR-0043) — declared in **trusted** config (repo/managed scope),
 * never supplied by a request. Provider **credentials never live here** — only the secret-var NAMES; the
 * values stay on the #25 `SecretsResolver`/`AGENT_SECRETS` path (the #57 convention). A deployment with no
 * `billing` section has opted out (the inbound routes → 409). All fields optional with no-spend defaults.
 */
export const billingSchema = z.object({
  /** Revenue backend (`none` default — no network | `stripe`). Mirrors the env-level BILLING_PROVIDER. */
  provider: z.enum(["none", "stripe"]).optional(),
  /** Default ISO 4217 currency for new prices (default `usd`). */
  currency: z.string().length(3).optional(),
  /** Name of the secret holding the Stripe API key (default `STRIPE_SECRET_KEY`). Value on secrets path. */
  secretKeyName: z.string().optional(),
  /** Name of the secret holding the webhook signing secret (default `STRIPE_WEBHOOK_SECRET`). */
  webhookSecretName: z.string().optional(),
});

/** The providers the selection layer (#52) understands. */
export const providerKinds = ["anthropic", "openai", "bedrock", "vertex", "custom"] as const;
export const providerKindSchema = z.enum(providerKinds);
/** Effort/thinking tiers (#52): `off` = no thinking budget; higher = larger `MAX_THINKING_TOKENS`. */
export const effortLevels = ["off", "low", "medium", "high"] as const;
export const effortLevelSchema = z.enum(effortLevels);
/** Session mode (#52): `single` = one model; `auto` = Opus plans → Sonnet implements. */
export const sessionModes = ["single", "auto"] as const;
export const sessionModeSchema = z.enum(sessionModes);

/**
 * Non-secret connection details for a provider (#52). A `baseUrl` (custom/openai gateway) is an
 * egress point gated by data-privacy mode; `region`/`projectId` configure Bedrock/Vertex. Provider
 * **credentials never live here** — they stay on the #25 `SecretsResolver` path, exactly like the
 * #57 `mcpServers.env` convention (names, never values).
 */
export const providerConnectionSchema = z.object({
  baseUrl: z.string().optional(),
  region: z.string().optional(),
  projectId: z.string().optional(),
});

/**
 * Model/provider selection policy (#52, ADR-0029). All **non-secret**: which providers/models a tenant
 * permits, the defaults, the Auto-mode model pair, and per-provider connection details. A managed-layer
 * tenant uses `allowedProviders`/`allowedModels` to pin selection; a session cannot pick outside it.
 */
export const modelsSchema = z.object({
  defaultProvider: providerKindSchema.optional(),
  defaultModel: z.string().optional(),
  allowedProviders: z.array(providerKindSchema).optional(),
  allowedModels: z.array(z.string()).optional(),
  defaultEffort: effortLevelSchema.optional(),
  defaultMode: sessionModeSchema.optional(),
  auto: z.object({ planModel: z.string(), implementModel: z.string() }).optional(),
  providers: z.record(providerKindSchema, providerConnectionSchema).optional(),
});

/**
 * Auto model-selection policy (convene-llm-gateway integration). When `enabled`, a session that pins
 * **no** explicit model (#52) asks the routing layer for the best model for its task — Claude is the
 * orchestrator + line of control (it validates worker output and escalates up to claude-opus-4-8).
 * All **non-secret**: a per-tenant on switch + an optional per-call cost ceiling. The gateway URL +
 * key are deployment env (never config), and the chosen model is still validated against the #52
 * `models` allow-list, so this widens nothing a tenant has not already permitted.
 *
 * Default OFF: with `enabled` unset (or the deployment-wide `RELOAD_AUTO_MODEL` flag / `LLM_GATEWAY_URL`
 * absent) every launch keeps today's behavior exactly — the deployment-default `ANTHROPIC_MODEL`.
 */
export const autoModelSchema = z.object({
  /** Per-tenant on switch. Default off — flip on in the managed layer for the owner workspace first. */
  enabled: z.boolean().optional(),
  /**
   * Per-call cost ceiling (cents) routed through to the gateway's policy. `0`/unset ⇒ derive from the
   * tenant's remaining #71 window budget (`scale.budgetCents` − accrued); a positive value pins it.
   */
  maxCallCostCents: z.number().int().nonnegative().optional(),
});

/**
 * Cloud-scale policy (#71, ADR-0040). All **non-secret** knobs an operator sets in the managed
 * (optionally per-tenant) layer to make a 24/7 fleet economical + elastic. Every field is optional
 * and defaults to **off** (no warm pool, unlimited concurrency, no budget, cost rate 0) so a
 * deployment that sets nothing keeps today's #25 behavior. `tenantConcurrency`/`budgetCents`/
 * `regions`/`computeRateCentsPerMinute` are per-tenant policy; `globalConcurrency` is a fleet
 * ceiling (managed-global) — see ADR-0040.
 */
export const scaleSchema = z.object({
  /** Per-region warm-pool buffer target; 0 = pool off (cold-provision every session). */
  warmPoolSize: z.number().int().nonnegative().optional(),
  /** Allowed placement regions; [] = unplaced (single-region #25 behavior). */
  regions: z.array(z.string()).optional(),
  /** Tie-break preference among `regions` when load is equal. */
  preferredRegion: z.string().optional(),
  /** Max in-flight sessions per tenant; 0 = unlimited. */
  tenantConcurrency: z.number().int().nonnegative().optional(),
  /** Fleet-wide in-flight ceiling (managed-global); 0/undefined → the env default. */
  globalConcurrency: z.number().int().nonnegative().optional(),
  /** Per-window cost cap in cents; 0 = no budget. */
  budgetCents: z.number().int().nonnegative().optional(),
  /** Cost-estimate rate (cents per compute-minute); 0 = cost always 0 (budget never bites). */
  computeRateCentsPerMinute: z.number().nonnegative().optional(),
  /**
   * Infra budget ceiling in cents (#113, links #108): the projected monthly compute cost the Founder
   * Console (#104) warns above so hosting can never surprise-bill. 0 = no ceiling (never bites). This
   * is a read-only *warning* threshold — admission/`budgetCents` remains the only thing that blocks a
   * launch.
   */
  infraBudgetCeilingCents: z.number().int().nonnegative().optional(),
});

/**
 * Venture-loop policy (#96, ADR-0049). All **non-secret** knobs for the YC-fundability gate. Every
 * field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing
 * keeps today's behavior — autonomy launches are never blocked. Thresholds parameterize the pure
 * `decideVenture`; `scorecardTtlMinutes` is how long a passing scorecard keeps admitting work.
 */
export const ventureSchema = z.object({
  /** The anti-demo admission gate flag — default OFF. */
  enabled: z.boolean().optional(),
  /**
   * Roll the gate out owner-workspace-first (#228, default true): even when `enabled`, enforce only on
   * `ownerWorkspaceId`. Set false to enforce on every tenant. Turning `enabled` on without naming the owner
   * workspace enforces on nobody — the safest default, mirroring `delivery`/`monetization`.
   */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — the gate dogfoods enforcement here first (falls back to marketing's). */
  ownerWorkspaceId: z.string().optional(),
  /** Score (0–100) at/above which an idea is FUNDed. */
  fundThreshold: z.number().int().min(0).max(100).optional(),
  /** Score (0–100) at/below which an idea is KILLed. */
  killThreshold: z.number().int().min(0).max(100).optional(),
  /** Width of the borderline band below `fundThreshold` that ESCALATEs instead of iterating. */
  escalateBand: z.number().int().min(0).max(100).optional(),
  /** Max passes before the loop exits to a human (the max-iteration termination). */
  maxIterations: z.number().int().positive().optional(),
  /** Weight on the adversarial Reviewer when combining the two personas (0–1). */
  reviewerWeight: z.number().min(0).max(1).optional(),
  /** How long (minutes) a passing scorecard stays valid for the admission gate. */
  scorecardTtlMinutes: z.number().int().positive().optional(),
  /** Estimated cost (cents) charged to tenant usage per scoring pass — the dollar ceiling input. */
  evaluationCostCents: z.number().int().nonnegative().optional(),
});

/**
 * Fleet-watchdog policy (#105, ADR-0105). All **non-secret** knobs for the stalled-session supervisor.
 * Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing
 * keeps today's #25 behavior (no detection, no revival). `staleCutoffMs` is the no-progress threshold;
 * `maxRevivalsPerWindow`/`windowMs`/`backoffMs` parameterize the bounded restart policy.
 */
export const watchdogSchema = z.object({
  /** The supervisor flag — default OFF. */
  enabled: z.boolean().optional(),
  /** No-progress age (ms) at/above which a non-terminal session is considered stalled. */
  staleCutoffMs: z.number().int().positive().optional(),
  /** Hard cap on revivals per rolling window before escalation (0 = never revive). */
  maxRevivalsPerWindow: z.number().int().nonnegative().optional(),
  /** Length (ms) of the rolling revival window the count is measured over. */
  windowMs: z.number().int().positive().optional(),
  /** Minimum time (ms) between revivals of one lineage (the backoff). */
  backoffMs: z.number().int().nonnegative().optional(),
});

/**
 * SRE Loop policy (#112, ADR-0112). All **non-secret** knobs for the agent-on-call loop. Every field
 * is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing keeps
 * today's behavior (no SLO evaluation, no incidents). `services` declares the per-service SLO targets
 * the loop evaluates off `/metrics` + health probes; `cooldownMs` bounds re-paging on a sustained
 * breach.
 */
export const sreServiceSchema = z.object({
  /** The service name evaluated (e.g. "api", "db", "redis"). */
  service: z.string().min(1),
  /** Availability SLO: minimum success ratio (0..1), e.g. 0.999. Omit to skip this dimension. */
  availabilityTarget: z.number().min(0).max(1).optional(),
  /** Latency SLO: maximum acceptable p95 latency in milliseconds. Omit to skip. */
  latencyP95Ms: z.number().positive().optional(),
  /** Queue-lag SLO: maximum acceptable queue lag in seconds. Omit to skip. */
  queueLagSeconds: z.number().nonnegative().optional(),
});

export const sreSchema = z.object({
  /** The on-call loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Minimum time (ms) between re-page notifications for one sustained breach (the cooldown). */
  cooldownMs: z.number().int().nonnegative().optional(),
  /** Per-service SLO targets the loop evaluates. Empty ⇒ nothing to evaluate. */
  services: z.array(sreServiceSchema).optional(),
});

/**
 * Self-Healing Ops policy (#193, ADR-0174): per-venture uptime/error/queue monitoring + bounded
 * auto-remediation. Every field is optional and defaults to **off** so a deployment that sets nothing
 * keeps today's behavior. `enabled` opts the workspace into per-venture probing + escalation;
 * `autoRemediate` is the INDEPENDENT second switch that lets remediation actions run (off ⇒ every breach
 * only escalates). Destructive actions (`allowRollback`/`allowScale`) are off and #13-gated by default;
 * `preCommitRollback`/`preCommitScale` let the owner pre-commit a bounded action to skip the gate
 * (#200 §4). `maxAutoAttempts` is the retry-once-then-escalate cap. Owner-workspace-first: ipop opts in
 * via the managed layer; `caps.test` stays OFF.
 */
export const selfHealingSchema = z.object({
  /** The self-healing loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Dispatch remediation actions automatically (else every breach escalates). Default OFF. */
  autoRemediate: z.boolean().optional(),
  /** Max acceptable error ratio (0..1) before the `error_rate` signal breaches. */
  errorRateThreshold: z.number().min(0).max(1).optional(),
  /** Max acceptable queue depth/backlog before the `queue_depth` signal breaches. */
  queueDepthThreshold: z.number().nonnegative().optional(),
  /** Allow the reversible restart action to auto-run. Default ON (no lasting effect). */
  allowRestart: z.boolean().optional(),
  /** Allow rollback-to-last-green (destructive). Default OFF. */
  allowRollback: z.boolean().optional(),
  /** Allow scale-within-caps (destructive: money). Default OFF. */
  allowScale: z.boolean().optional(),
  /** Gate rollback/scale through a #13 approval. Default ON. */
  requireApprovalForDestructive: z.boolean().optional(),
  /** Owner pre-committed rollback as a bounded action — auto-run without an approval. Default OFF. */
  preCommitRollback: z.boolean().optional(),
  /** Owner pre-committed scale as a bounded action — auto-run without an approval. Default OFF. */
  preCommitScale: z.boolean().optional(),
  /** Auto-remediation attempts before escalating to a human (retry-once ⇒ 1). */
  maxAutoAttempts: z.number().int().nonnegative().optional(),
});

/**
 * Reliability surface policy (#148, ADR-0148): the incident.io-class operating layer on top of the #112
 * SRE loop — owner paging, chat-native incidents, the AI investigation note, and the public status
 * page. Every field is optional and defaults to **off** (`enabled: false`, `statusPageEnabled: false`)
 * so a deployment that sets nothing keeps today's #112 behavior (one ops-channel post, no pages, no
 * public page). `enabled` is the master switch for paging + war-room channels + investigation;
 * `statusPageEnabled` independently opts the workspace's slug into the no-auth `/status/:slug` page.
 * Quiet hours hold non-critical pages; `maxPagesPerHour` rate-limits; `escalateAfterMs` is the unacked
 * re-page interval. Secret-var NAMES only (`smtpUrlVar`) — never a value.
 */
export const reliabilitySchema = z.object({
  /** Master flag for owner paging + chat-native incidents + AI investigation — default OFF. */
  enabled: z.boolean().optional(),
  /** Quiet-hours window start (whole UTC hour 0..23, inclusive). Set with the end to enable. */
  quietHoursStartHourUtc: z.number().int().min(0).max(23).optional(),
  /** Quiet-hours window end (whole UTC hour 0..23, exclusive). Equal to start ⇒ no quiet window. */
  quietHoursEndHourUtc: z.number().int().min(0).max(23).optional(),
  /** Hard cap on pages delivered to the owner per rolling hour (rate limit). */
  maxPagesPerHour: z.number().int().positive().optional(),
  /** Minimum ms between escalation re-pages for one unacked incident. */
  escalateAfterMs: z.number().int().nonnegative().optional(),
  /** Whether a resolved/recovered incident sends a closure page (default true). */
  pageOnResolve: z.boolean().optional(),
  /** How far before an incident a deploy still counts as a likely cause (the investigation window). */
  deployWindowMs: z.number().int().nonnegative().optional(),
  /** Opt the workspace's slug into the public no-auth `/status/:slug` page — default OFF. */
  statusPageEnabled: z.boolean().optional(),
  /** Sender address for email pages (display only; the transport is the plug). */
  emailFrom: z.string().optional(),
  /** The env-var NAME (never a value) holding the SMTP URL the email transport reads. */
  smtpUrlVar: z.string().optional(),
});

/**
 * Evidence-Priced Autonomy policy (#119, ADR-0119). All **non-secret** knobs for the gate pricer that
 * auto-relaxes / re-tightens #95 approval rules on measured decision error. Every field is optional and
 * defaults to **off** (`enabled: false`) so a deployment that sets nothing keeps today's static gates —
 * only evidence *recording* is always-on. `windowSize`/`minSamples` size the trailing window;
 * `relaxBelowRate` < `retightenAboveRate` are the hysteresis rails (the dead band that prevents flapping).
 */
export const gatePricingSchema = z.object({
  /** The auto-relax/re-tighten pricer flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Trailing-window size: recent decisions per action class the pricer measures. */
  windowSize: z.number().int().positive().optional(),
  /** Minimum decisions before a strict boundary may relax (the insufficient-evidence guard). */
  minSamples: z.number().int().positive().optional(),
  /** Error rate strictly below which a strict boundary RELAXes (0–1). */
  relaxBelowRate: z.number().min(0).max(1).optional(),
  /** Error rate strictly above which a relaxed boundary RE-TIGHTENs (0–1; must exceed `relaxBelowRate`). */
  retightenAboveRate: z.number().min(0).max(1).optional(),
});

/**
 * Self-Healing Flywheel policy (#117, ADR-0117). All **non-secret** knobs for the failure→issue→fix
 * loop. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets
 * nothing files no issues and dispatches no fixes. `issueThreshold` is the occurrence count that earns
 * an issue; `maxIssuesPerTick` rate-limits GitHub writes; `maxConcurrentFixes` is the hard cap on
 * in-flight fix sessions; `maxDispatchesPerTick` bounds fixes proposed per pass.
 */
export const flywheelSchema = z.object({
  /** The flywheel flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Occurrence count at/above which a never-issued fingerprint earns a drafted issue. */
  issueThreshold: z.number().int().positive().optional(),
  /** Hard cap on NEW issues drafted in a single tick (the GitHub-write rate limit). */
  maxIssuesPerTick: z.number().int().nonnegative().optional(),
  /** Hard cap on concurrent in-flight fix sessions per workspace (0 = never auto-dispatch). */
  maxConcurrentFixes: z.number().int().nonnegative().optional(),
  /** Hard cap on fix dispatches proposed in a single tick (top-ranked first). */
  maxDispatchesPerTick: z.number().int().nonnegative().optional(),
});

/**
 * Self-QA Loop policy (#171, ADR-0171). All **non-secret** knobs for the synthetic-user E2E QA pass that
 * drives the live product and files its own deduped bug issues. Every field is optional and defaults to
 * **off** (`enabled: false`), so a deployment that sets nothing runs no synthetic QA. `workspaceSlug` is
 * the reserved, tenant-isolated synthetic workspace the runner is allowed to touch — never a real tenant.
 */
export const selfqaSchema = z.object({
  /** The self-QA flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Reserved slug of the dedicated synthetic QA workspace (the only one the runner will drive). */
  workspaceSlug: z.string().optional(),
  /** Hard cap on findings turned into issues in a single run (a runaway-page bound). */
  maxFindingsPerRun: z.number().int().nonnegative().optional(),
  /** Whether a critical finding pages the workspace owner via the #148 reliability seam. */
  pageCriticalOwner: z.boolean().optional(),
});

/**
 * Outcome Verifiers policy (#106, ADR-0106). All **non-secret** knobs for the measured-gate runner that
 * turns non-code claims (deploy live? revenue real? growth moved? fix held?) into durable evidence rows.
 * Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing
 * runs no verification. `escalateOnFailure` is the "no silent pass" rail (default true — a failed gate
 * opens a #13 escalation); `maxPerTick` bounds verifications + escalations per workspace pass.
 */
export const verifiersSchema = z.object({
  /** The verifier loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Whether a measured FAILURE opens a #13 escalation (default true — never silently pass). */
  escalateOnFailure: z.boolean().optional(),
  /** Hard cap on verifications performed in a single workspace tick. */
  maxPerTick: z.number().int().positive().optional(),
});

/**
 * Deliverable Verification Layer policy (#191, ADR-0191). All **non-secret** knobs for the layer that
 * gates a deliverable (outbound content, support reply, campaign change, venture deploy) on an INDEPENDENT
 * verifier pass against a definition of done. Every field is optional and defaults to **off**
 * (`enabled: false`) so a deployment that sets nothing gates nothing and behaves exactly as today. The
 * rails are conservative by design (premortem #200): `autoSendReversible` defaults **false** (a verified
 * deliverable still waits for a human) and `requireProductionGrounding` defaults **true** (the final
 * real-world tier is required for venture deploys / irreversible deliverables / production criteria).
 */
export const verificationSchema = z.object({
  /** The verification layer flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Confidence a passing verdict needs to clear without a human second look (0..1; default 0.8). */
  minConfidence: z.number().min(0).max(1).optional(),
  /** Bounded fail→fix retries before a repeated failure escalates to the decision queue (default 2). */
  maxRetries: z.number().int().nonnegative().optional(),
  /** Whether a verified REVERSIBLE deliverable may auto-proceed without a human (default false). */
  autoSendReversible: z.boolean().optional(),
  /** Whether the production-grounded final tier is required where it applies (default true). */
  requireProductionGrounding: z.boolean().optional(),
});

/**
 * Marketing department fleet policy (#123, ADR-0123). All **non-secret**. Every field is optional and
 * defaults to **off** (`enabled: false`) so a deployment that sets nothing keeps today's signup
 * behavior (no auto-seed). ipop.ai opts in via the managed layer; `enabled` gates only seed-on-signup
 * (the explicit seed route always works). `seedWelcomeTasks` launches one welcome session per
 * department on seed (the "prove each agent alive" brief).
 */
export const marketingSchema = z.object({
  /** Auto-seed the department fleet on signup — default OFF. */
  enabled: z.boolean().optional(),
  /** Launch one welcome session per department when seeding (default true). */
  seedWelcomeTasks: z.boolean().optional(),
  /**
   * The owner's own workspace id (#235). When a seeded workspace matches this, its founding venture is the
   * ipop **dogfood** venture ("acquire paying founders for ipop.ai") rather than the brand-neutral founding
   * stub — so ipop runs its OWN marketing as venture #1. Default unset ⇒ every workspace gets the generic
   * founding venture (a customer never inherits ipop's growth brief).
   */
  ownerWorkspaceId: z.string().optional(),
  /**
   * The workspace's real, public marketing site URL (#250) — substituted into the `{{site}}` template
   * variable so a seeded task (the SEO audit) points the fleet at a real domain instead of the generic
   * `"our website"` placeholder. Default unset ⇒ the owner workspace falls back to `https://ipop.ai`
   * (the ipop dogfood site, see {@link resolveSiteUrl}) and any other workspace keeps the placeholder.
   */
  siteUrl: z.string().optional(),
  /**
   * Idempotent task / draft dedup (#322) — default OFF. When on, the launch seam skips re-opening a task
   * whose normalized objective already has an OPEN task in the same department (no duplicate sessions /
   * drafts), and the pending-approvals read collapses identical-objective deliverable drafts to one card.
   * Rolls out owner-workspace-first (see {@link dedupeOwnerWorkspaceOnly}), reusing `ownerWorkspaceId`.
   */
  dedupeTasks: z.boolean().optional(),
  /**
   * Restrict dedup to the owner workspace (default true). Even with `dedupeTasks` on, only `ownerWorkspaceId`
   * dedups; set false to apply to every tenant once the owner workspace has proven the path. Turning
   * `dedupeTasks` on without naming the owner workspace dedups for NObody (the safest default).
   */
  dedupeOwnerWorkspaceOnly: z.boolean().optional(),
  /**
   * Inject a workspace-context preamble (resolved site URL + owner-typed product context + brand voice)
   * into every briefed/@mentioned agent task (#320) so Scout/Lens/… act on real facts instead of
   * returning placeholder drafts. Default OFF and gated owner-workspace-first (see
   * `shouldInjectWorkspaceContext`): active only for the `ownerWorkspaceId` workspace until rolled out
   * wider, so an unconfigured deployment changes no briefed task. The facts are sanitized + framed as DATA
   * (#200 FM#6 injection defense) — never run as instructions.
   */
  injectWorkspaceContext: z.boolean().optional(),
});

/**
 * Growth-loop policy (#102, ADR-0102). All **non-secret** knobs for the distribution-instrumentation
 * loop. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets
 * nothing surfaces a zeroed growth pane and proposes nothing proactively — event ingest via the API is
 * always available regardless (recording is harmless). `minTrafficForScore` is the acquisition floor
 * below which a funnel score is forced to 0 (a high rate off a handful of visitors is noise).
 */
export const growthSchema = z.object({
  /** The growth-loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Acquisition count below which the growth score is forced to 0 (not enough signal). */
  minTrafficForScore: z.number().int().nonnegative().optional(),
});

/**
 * Decision-maker resolver policy (#223, ADR-0223). All **non-secret** knobs for the resolver that turns a
 * target account (#222) into a buyer brief. Default **off** (`enabled: false`): the flag gates the
 * proactive, LIVE web-reading posture (the quarantined #174 browser fetching public profiles) — producing
 * a brief from public text the discovery layer already fetched is harmless and always available.
 * `maxHooks` narrows the video's "2–3 angle hooks" (clamped into `[1, 3]` by `resolveDecisionMakerCaps`).
 */
export const decisionMakerSchema = z.object({
  /** The proactive/live-reading flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Max angle hooks per brief (clamped to `[1, 3]`). */
  maxHooks: z.number().int().positive().optional(),
});

/**
 * Customer Discovery Engine policy (#222, ADR-0222). Knobs for the per-venture signal layer that turns
 * real product-usage + channel receipts into a ranked "who to reach out to now" queue + PQL events.
 * Every field is optional and the master `enabled` defaults OFF — but note: signal ingest, the ranked
 * queue read, the PQL detection and the (downstream) growth-funnel emission are ALWAYS live when the
 * engine is exercised (a workspace that ingests no signals stays byte-for-byte unchanged). `enabled`
 * gates only the proactive posture (reserved for the outreach-prep tick that #225 will own). This issue
 * is READ-ONLY: it never sends. `queueLimit` caps the daily queue; `defaultWindowDays` is the lookback
 * a signal definition uses when it sets none; `ownerWorkspaceId` marks the owner's own workspace for the
 * owner-first rollout.
 */
export const discoverySchema = z.object({
  /** The proactive-posture flag — default OFF (ingest/queue/PQL/emission are always live regardless). */
  enabled: z.boolean().optional(),
  /** Max rows the daily ranked discovery queue returns (top-N). */
  queueLimit: z.number().int().positive().optional(),
  /** Default lookback window (days) a signal definition uses when it specifies none. */
  defaultWindowDays: z.number().int().positive().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Agent Registry + A2A policy (#282, ADR-0282). Non-secret knobs for the department-fleet registry and
 * the agent-to-agent (A2A) call surface. Every field is optional and the master `enabled` defaults **OFF**
 * AND **owner-workspace-first** (`ownerWorkspaceOnly: true`) — a deployment that sets nothing exposes the
 * contract catalog read-only (harmless) but enables NO A2A call in any workspace, so today's behavior is
 * unchanged. `maxCallDepth` is the bounded-autonomy depth cap the pure A2A decision enforces (premortem
 * #200 §5). `ownerWorkspaceId` marks the owner's own workspace for the owner-first rollout.
 */
export const agentRegistrySchema = z.object({
  /** The A2A feature flag — discovery lists regardless; A2A calls are OFF unless this is true. */
  enabled: z.boolean().optional(),
  /** Restrict A2A calls to the owner workspace first (default true). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** Hard cap on A2A call depth (bounded autonomy, #200 §5). */
  maxCallDepth: z.number().int().positive().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Agent collaboration policy (#319, ADR-0319). Whether a scoped fleet session is provisioned with the
 * subagent-**spawn** tool so a department lead can delegate to a teammate ("collaborate"). Every field is
 * optional and the master `enabled` defaults **OFF** AND **owner-workspace-first** (`ownerWorkspaceOnly:
 * true`) — a deployment that sets nothing keeps today's tool surface exactly (drafts only, no spawn), so
 * behavior is unchanged. Turning it on without naming `ownerWorkspaceId` provisions it for nobody (the
 * safest default, matching `agentRegistry`/`venture`/`delivery`). Spawn is a model-spend amplifier, so it
 * stays gated behind the owner's own workspace until proven; broaden with `ownerWorkspaceOnly: false`.
 */
export const agentCollaborationSchema = z.object({
  /** Provision the subagent-spawn tool into scoped sessions — default OFF (drafts-only otherwise). */
  enabled: z.boolean().optional(),
  /** Restrict spawn provisioning to the owner workspace first (default true). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Connect-Claude policy (#262, ADR-0262). Non-secret knobs for the in-app one-click "Connect Claude"
 * flow that replaces the `claude setup-token` CLI step. Every field is optional and the master `enabled`
 * defaults **OFF** AND **owner-workspace-first** (`ownerWorkspaceOnly: true`) — a deployment that sets
 * nothing keeps today's manual paste path (behind the #263 Advanced disclosure), so behavior is unchanged.
 * The OAuth client itself is env-driven (never in this non-secret config), so even with `enabled: true`
 * the flow is an honest `coming_soon` until a live client is wired. `ownerWorkspaceId` marks the owner's
 * own workspace for the owner-first rollout.
 */
export const connectClaudeSchema = z.object({
  /** The managed one-click connect flag — default OFF (the manual paste path always remains). */
  enabled: z.boolean().optional(),
  /** Restrict the managed flow to the owner workspace first (default true). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Connect-once LIVE-flow policy (#258 Stage 2, ADR-0258). Non-secret knobs for the shared connect-once
 * seam — the live customer-OAuth connect flow that actually mints a real credential (Search Console for
 * Scout, an ESP for Postmark, social for Echo, an ad account for Bid) and seals it into the #192 vault.
 * Every field is optional and the master `enabled` defaults **OFF** AND **owner-workspace-first**
 * (`ownerWorkspaceOnly: true`, mirrors `connectClaude`/`delivery`/`skillopt`): a deployment that sets nothing
 * keeps the #258 Stage 1 behavior — every customer connector renders the honest `coming_soon`. The OAuth
 * clients themselves are env-driven (never in this non-secret config) and unwired in this slice, so even
 * with `enabled: true` the flow stays `coming_soon` until a per-department follow-up wires a live client.
 * Enabling does NOT bypass the per-connect approval: the live connect ALWAYS pauses for the owner (a
 * structural #13 always-gate). `ownerWorkspaceId` marks the owner's own workspace for the owner-first rollout.
 */
export const connectOnceSchema = z.object({
  /** The live customer-OAuth connect flag — default OFF (the #258 Stage 1 `coming_soon` stub stays). */
  enabled: z.boolean().optional(),
  /** Restrict the live flow to the owner workspace first (default true). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Low-commitment signup-entry policy (#300, ADR-0300). Non-secret knobs for the front-door alternatives to
 * the broad-scope Google OAuth wall: a read-only **sample workspace** a prospect can explore before signing
 * up, and **progressive Google scopes** that request only identity at signup and defer Search Console /
 * Analytics to the moment SEO work is actually initiated. Both fields are optional and default **OFF** so a
 * deployment that sets nothing keeps today's #260 behavior exactly (Google-only entry, single full-scope
 * consent). These are anonymous front-door features (no workspace exists yet), so the deployment flag IS the
 * owner-first control — the owner turns it on for their own deployment first (see ADR-0300).
 */
export const signupEntrySchema = z.object({
  /** Offer the read-only sample/demo workspace from `/start` — default OFF. */
  sampleWorkspace: z.boolean().optional(),
  /**
   * Request identity-only Google scopes at signup, deferring GSC/Analytics until SEO work is initiated
   * (progressive consent) — default OFF (the single #260 full-scope consent at signup).
   */
  progressiveScopes: z.boolean().optional(),
});

/**
 * Email deliverability + compliance pipeline policy (#268, ADR-0268). Non-secret knobs for the Postmark
 * deliverability lane — SPF/DKIM/DMARC verification, RFC 8058 one-click unsubscribe, suppression, and send
 * rate caps (all reused from the #189/#264 seams). The one knob that matters for safety is `liveSendEnabled`:
 * it gates whether a *real* Postmark send is even eligible to be proposed. It defaults **OFF** AND
 * **owner-workspace-first** (`ownerWorkspaceOnly: true`, mirrors `connectOnce`/`delivery`): a deployment that
 * sets nothing never sends a real email — the dry-run sender stays the byte-for-byte default. Even with
 * `liveSendEnabled: true` a real send is NEVER autonomous: it is the structural #13 always-gate
 * (`email.live_send`) the owner must approve per send (premortem #200 §4 — sending real email is
 * irreversible). The Postmark server token + unsubscribe HMAC secret are env/#192-vault driven, never in this
 * non-secret config, so enabling alone wires nothing live. `ratePerMinute` is the rolling-window send cap.
 */
export const emailDeliverabilitySchema = z.object({
  /** Whether a real Postmark send is eligible to be proposed (still owner-approved per send) — default OFF. */
  liveSendEnabled: z.boolean().optional(),
  /** Restrict live-send eligibility to the owner workspace first (default true). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
  /** The rolling-window (per-minute) send rate cap; the warmup per-day schedule still applies on top. */
  ratePerMinute: z.number().int().positive().optional(),
  /** Optional mailto fallback added to the RFC 8058 `List-Unsubscribe` header. */
  unsubscribeMailto: z.string().optional(),
});

/**
 * Insight Miner policy (#100, ADR-0100). All **non-secret** knobs for the evidence-mining loop that
 * feeds the Venture Loop (#96) SOURCE stage. Every field is optional and defaults to **off**
 * (`enabled: false`) so a deployment that sets nothing mines nothing and spends nothing. Only the
 * agent-session mining path is gated/charged; owner-secret intake and source ranking are ungated.
 * `freshnessHalfLifeDays` parameterizes the recency decay; `mineCostCents` is the per-pass charge
 * against the #71 tenant budget; `minSourceStrength` is the "list is the strategy" cut (only mine
 * sources at/above this evidence strength); `maxInsightsPerMine` rate-limits insights per pass.
 */
export const insightSchema = z.object({
  /** The mining flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Half-life (days) of the freshness decay applied to source/insight recency. */
  freshnessHalfLifeDays: z.number().positive().optional(),
  /** Estimated cost (cents) charged to tenant usage per mining pass — the dollar-ceiling input. */
  mineCostCents: z.number().int().nonnegative().optional(),
  /** Hard cap on insights produced in a single mining pass (top-ranked sources first). */
  maxInsightsPerMine: z.number().int().nonnegative().optional(),
  /** Minimum source evidence strength (0–100) to mine — the "list is the strategy" cut. */
  minSourceStrength: z.number().int().min(0).max(100).optional(),
});

/**
 * Moat-accrual policy (#103, ADR-0103). All **non-secret** knobs for the moat scoring + stagnation
 * flagging. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that
 * sets nothing keeps today's behavior — moat is recorded/scored on demand but no venture is flagged.
 * `stagnationWindowDays` is the trailing window a zero-accrual venture is flagged over; the `weight*`
 * fields parameterize the pure `scoreMoat` aggregate (equal-weighted by default).
 */
export const moatSchema = z.object({
  /** The Founder Console stagnation-flagging flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Trailing window (days) a venture with zero accrual is flagged stagnant over. */
  stagnationWindowDays: z.number().int().positive().optional(),
  /** Weight on the proprietary-data dimension when combining subscores (≥ 0). */
  weightProprietaryData: z.number().nonnegative().optional(),
  /** Weight on the switching-costs dimension (≥ 0). */
  weightSwitchingCosts: z.number().nonnegative().optional(),
  /** Weight on the distribution-lock-in dimension (≥ 0). */
  weightDistributionLockIn: z.number().nonnegative().optional(),
  /** Weight on the accumulated-evals/skills dimension (≥ 0). */
  weightAccumulatedEvals: z.number().nonnegative().optional(),
});

/**
 * Customer Voice Loop policy (#114, ADR-0114). All **non-secret** knobs for the post-launch support /
 * feedback / churn loop. Every field is optional and defaults to **off** (`enabled: false`,
 * `autoTriageDraft: false`) so a deployment that sets nothing ingests + classifies + reads (harmless,
 * tenant-scoped) but never has an agent draft a reply proactively — and outbound replies are ALWAYS the
 * #13 human gate regardless of this block. The inbound webhook is separately secret-gated (no secret ⇒
 * the route 503s). `digestWindowDays` is the trailing window the voice-of-customer digest rolls up.
 */
export const voiceSchema = z.object({
  /** The proactive-voice flag (gates auto-draft posture) — default OFF. */
  enabled: z.boolean().optional(),
  /** Trailing window (days) the voice-of-customer digest aggregates. */
  digestWindowDays: z.number().int().positive().optional(),
  /** Whether the triage agent drafts a reply on ticket ingest — default OFF (the ticket lands open). */
  autoTriageDraft: z.boolean().optional(),
});

/**
 * Support Desk policy (#190, ADR-0190). The **bounded-autonomy** knobs layered on the #114 voice loop.
 * Every field defaults OFF / conservative (see `resolveSupportDeskCaps`). `autoSend` is the master switch
 * for autonomous replies — and even when ON, an autonomous send only happens for a category in
 * `autoSendCategories`, under `autoSendMaxPerDay`, in the owner workspace when `ownerWorkspaceOnly`, and
 * only if an `AutoApprover` is wired (the default wiring leaves it unset). A poisoned inbound message can
 * never flip these — the routing decision reads the classification, never instructions in the body
 * (premortem #200 §4/§6). Refunds are NEVER autonomous regardless of this block.
 */
export const supportDeskSchema = z.object({
  /** The support-desk feature flag (KB reads, SLA, receipts, recurring-issue filing) — default OFF. */
  enabled: z.boolean().optional(),
  /** The autonomous-reply master switch — default OFF. OFF ⇒ every reply is a #13 human gate. */
  autoSend: z.boolean().optional(),
  /** The narrow allowlist of categories an autonomous reply may answer (e.g. `support`). */
  autoSendCategories: z.array(z.string()).optional(),
  /** Restrict autonomous sends to the owner workspace first — default ON (owner workspace first). */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** Bounded blast radius: the max autonomous sends per workspace per rolling day. */
  autoSendMaxPerDay: z.number().int().positive().optional(),
  /** The first-response SLA window (minutes); breaches surface read-only in the founder brief. */
  firstResponseSlaMinutes: z.number().int().positive().optional(),
  /** How many same-fingerprint complaints before one deduped backlog issue is filed (the #117 way). */
  recurringComplaintThreshold: z.number().int().positive().optional(),
});

/**
 * Portfolio Lifecycle Loop policy (#107, ADR-0107). All **non-secret** knobs for the launched-venture
 * review loop. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that
 * sets nothing keeps today's behavior — reviews still compute/persist on demand (harmless, tenant-scoped)
 * but the Founder Console raises no portfolio attention and no proactive tick runs. SUNSET execution
 * stays #13-gated regardless. The threshold/weight fields parameterize the pure `decidePortfolio` ladder
 * and ARE the per-venture targets the review judges against (the tenant's layered, lockable policy).
 */
/**
 * Legal & Compliance pack policy (#196, ADR-0196). All non-secret knobs for the per-venture legal pack.
 * Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing
 * keeps today's behavior: documents can still be generated/read on demand (harmless), but the send-layer
 * `ComplianceEnforcer` is a no-op (no real send is blocked) and nothing auto-regenerates. The owner
 * workspace opts in first.
 */
export const legalSchema = z.object({
  /** Master switch for the pack — gates send-layer enforcement + auto-regeneration. Default OFF. */
  enabled: z.boolean().optional(),
  /** Regenerate ToS/privacy + open an owner-review approval when venture facts materially change. Default OFF. */
  autoRegenerate: z.boolean().optional(),
  /** Require a recorded consent basis for a commercial email send (CASL/GDPR). Default ON (bites only when enabled). */
  requireConsentForEmail: z.boolean().optional(),
});

export const portfolioSchema = z.object({
  /** The portfolio-loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Composite health (0–100) at/above which a venture earns more investment (DOUBLE_DOWN). */
  doubleDownScore: z.number().min(0).max(100).optional(),
  /** Composite health (0–100) at/below which a venture is a SUNSET candidate. */
  sunsetScore: z.number().min(0).max(100).optional(),
  /** Days since launch below which the loop holds at MAINTAIN (grace window for a fresh launch). */
  minReviewAgeDays: z.number().int().nonnegative().optional(),
  /** Per-signal points for the bounded demand sub-score (capped at 100). */
  demandSignalPoints: z.number().nonnegative().optional(),
  /** Weight on the growth score in the composite (≥ 0). */
  weightGrowth: z.number().nonnegative().optional(),
  /** Weight on the moat score in the composite (≥ 0). */
  weightMoat: z.number().nonnegative().optional(),
  /** Weight on the demand sub-score in the composite (≥ 0). */
  weightDemand: z.number().nonnegative().optional(),
});

/**
 * Product Planning Loop policy (#115, ADR-0115). All **non-secret** knobs for the feedback+metrics →
 * RICE-ranked backlog → specs → agent sessions loop. Every field is optional and defaults to **off**
 * (`enabled: false`) so a deployment that sets nothing drafts no specs and proposes no sessions —
 * recording backlog items + reading the ranked backlog stay available regardless (harmless). `enabled`
 * gates only the proactive tick. `autoEffortCeiling` is the effort above which an item is an
 * "over-budget effort" (→ #13 gate); `dispatchCostCents` is the per-dispatch charge against the #71
 * budget; `maxDispatchesPerTick` bounds proposals per pass.
 */
export const planningSchema = z.object({
  /** The planning-tick flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Effort (points) above which an item is an "over-budget effort" → #13 gate (never auto). */
  autoEffortCeiling: z.number().int().nonnegative().optional(),
  /** Estimated cost (cents) charged to tenant usage per auto-dispatch — the dollar-ceiling input. */
  dispatchCostCents: z.number().int().nonnegative().optional(),
  /** Hard cap on auto-dispatches proposed in a single tick (top-ranked first). */
  maxDispatchesPerTick: z.number().int().nonnegative().optional(),
});

/**
 * Venture Memory & Planning policy (#197, ADR-0197). All **non-secret** knobs for the per-venture memory
 * + weekly planning loop. Every field is optional and defaults to **off** (`enabled: false`) so a
 * deployment that sets nothing drafts no weekly plans and distills no playbooks — recording venture
 * memory/OKRs and reading beliefs/OKRs/plans/playbooks stay available regardless (harmless). `enabled`
 * gates only the proactive weekly tick. `staleAfterDays` is the memory-hygiene review window;
 * `dispatchOnApprove` flows an APPROVED plan's items into the #115 backlog (which auto-dispatches).
 */
export const ventureMemorySchema = z.object({
  /** The weekly planning-tick flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Hard cap on items a single weekly plan drafts. */
  maxPlanItems: z.number().int().nonnegative().optional(),
  /** Memories older than this (and not superseded) are surfaced for owner review. 0 ⇒ never. */
  staleAfterDays: z.number().int().nonnegative().optional(),
  /** Max memories rendered per kind in a session brief (bounds the injected text). */
  maxBriefPerKind: z.number().int().nonnegative().optional(),
  /** Max candidate playbooks offered into a plan draft. */
  maxPlaybookCandidates: z.number().int().nonnegative().optional(),
  /** When true, an APPROVED plan's items flow into the #115 backlog (which auto-dispatches). */
  dispatchOnApprove: z.boolean().optional(),
});

/**
 * Venture Factory policy (#187, ADR-0187). All **non-secret** knobs for the idea → validated → launched
 * pipeline. Every field is optional and defaults to **off** (`enabled: false`) AND **owner workspace
 * first** (`ownerWorkspaceOnly: true`) so a deployment that sets nothing runs no scanner, ships no smoke
 * test, and bootstraps no venture (recording/reading candidates stays available, harmless). `enabled`
 * gates the proactive scanner/validation/bootstrap tick. The thresholds parameterize the pure
 * `scanner`/`validation`/`edge-gate` modules; `validationBudgetCapCents` is the HARD smoke-test cap;
 * `requireProfitableBeforeScale` enforces premortem #200 FM#1 (make ONE venture profitable first).
 */
export const ventureFactorySchema = z.object({
  /** The factory flag — default OFF. */
  enabled: z.boolean().optional(),
  /** When true (default), the autonomous factory runs only in the owner's own workspace. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** Half-life (days) for candidate freshness decay. */
  freshnessHalfLifeDays: z.number().nonnegative().optional(),
  /** Minimum opportunity score for a candidate to earn a validation experiment. */
  minScoreToValidate: z.number().min(0).max(100).optional(),
  /** The HARD validation budget cap (cents) per smoke test. */
  validationBudgetCapCents: z.number().int().nonnegative().optional(),
  /** Points per external signup when scoring a validation scorecard. */
  pointsPerSignup: z.number().nonnegative().optional(),
  /** Minimum EXTERNAL signups to PROMOTE a validated candidate. */
  minSignupsToPromote: z.number().int().nonnegative().optional(),
  /** Maximum acceptable CAC (cents) to PROMOTE. */
  maxCacCents: z.number().int().nonnegative().optional(),
  /** Signups at/below which validation is a clear KILL. */
  killSignups: z.number().int().nonnegative().optional(),
  /** Hard cap on concurrently-active ventures (the scaling gate). */
  maxConcurrentVentures: z.number().int().positive().optional(),
  /** Bar a new bootstrap until at least one venture is externally profitable (FM#1). */
  requireProfitableBeforeScale: z.boolean().optional(),
  /** Estimated cost (cents) charged to tenant usage per scan pass. */
  scanCostCents: z.number().int().nonnegative().optional(),
});

/**
 * Venture Deploys policy (#195, ADR-0195): the fleet provisions a per-venture deploy target at bootstrap
 * and runs the review→CI→merge→deploy→post-deploy-smoke release pipeline on the venture repo, auto-rolling
 * back a broken image. **Default OFF** (`enabled: false`) and **owner-workspace first**. The release gate
 * is production-grounded (a real deploy + smoke is the only path to a customer-facing promote, #200 §3);
 * the prod cutover is gated/pre-committed and the auto-rollback is the pre-committed safety action (#200 §4).
 */
export const ventureDeploysSchema = z.object({
  /** The feature flag — default OFF. */
  enabled: z.boolean().optional(),
  /** When true (default), provisioning + releases run only in the owner's own workspace. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The infra backend: `dryrun` (no spend, default) | `fly` | `vercel`. */
  provider: z.enum(["dryrun", "fly", "vercel"]).optional(),
  /** Hard per-venture cap (cents) on one-time provisioning spend (charged against the tenant ceiling). */
  infraSetupCapCents: z.number().int().nonnegative().optional(),
  /** Roll back a broken image without a human — the pre-committed safety action (default ON, #195 AC3). */
  autoRollbackOnSmokeFail: z.boolean().optional(),
  /** Gate the prod cutover behind a #13 approval (default ON — the irreversible-ish customer cutover). */
  requireApprovalForProdPromote: z.boolean().optional(),
  /** Owner pre-committed autonomous prod cutovers once smoke is green (default OFF, #200 §4). */
  preCommitProdPromote: z.boolean().optional(),
  /** File a #193 self-healing incident when a release fails / rolls back (default ON). */
  fileIncidentOnFailure: z.boolean().optional(),
});

/**
 * Per-agent scoped credentials policy (#151, ADR-0151). All **non-secret** — only secret KEY NAMES
 * grouped by purpose; the secret VALUES stay on the #25 `SecretsResolver`/`AGENT_SECRETS` path. Every
 * field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing keeps
 * today's per-tenant resolution (every agent gets the full secret set). When enabled, an agent absent
 * from `agents` receives only the #68 model-auth keys (deny-by-default). `purposes` maps a purpose name
 * to the key names it covers; `agents` maps an agent persona name (@handle) to the purposes it may use.
 */
export const credentialScopesSchema = z.object({
  /** The per-agent scoping flag — default OFF (per-tenant resolution unchanged). */
  enabled: z.boolean().optional(),
  /** Purpose → secret KEY names (e.g. `crawl: ["CRAWL_TOKEN"]`). Values never live here. */
  purposes: z.record(z.string(), z.array(z.string())).optional(),
  /** Agent persona name → allowed purposes (e.g. `scout: ["crawl"]`). */
  agents: z.record(z.string(), z.array(z.string())).optional(),
});

/**
 * Egress domain allowlist policy (#151, ADR-0151) for cloud agent sessions. Non-secret. Every field is
 * optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing keeps today's
 * behavior (the binary #58 `dataPrivacyMode` remains the only egress gate). When enabled, only listed
 * domains are reachable (exact or leading-`*.` wildcard); everything else is denied + flagged to the
 * `egress_violations` audit.
 */
export const egressSchema = z.object({
  /** The domain-allowlist flag — default OFF (unrestricted egress, today's behavior). */
  enabled: z.boolean().optional(),
  /** Allowed domains: exact (`api.example.com`) or leading-wildcard (`*.example.com`). */
  allowlist: z.array(z.string()).optional(),
});

/**
 * Agent browser runtime policy (#174, ADR-0174). All **non-secret** knobs for the Playwright-driven
 * Chromium each session can drive. Every field is optional and defaults to **off** (`enabled: false`)
 * so a deployment that sets nothing exposes no browser to any agent — owner workspace opts in first.
 * `maxPages` / `maxWallClockSeconds` / `maxBandwidthBytes` are the per-session hard caps (`0` =
 * unlimited, the project-wide convention). `allowlist` / `denylist` reuse the #151 domain matcher
 * (exact or leading-`*.` wildcard): a denylisted domain is blocked for reads AND writes; an enabled
 * allowlist restricts navigation to the listed domains. Side-effectful actions are always #13-gated
 * regardless of these lists — the lists scope *where* the browser may go, not *whether* it may mutate.
 */
export const browserSchema = z.object({
  /** The agent-browser flag — default OFF (no session gets a browser). */
  enabled: z.boolean().optional(),
  /** Hard cap on page navigations per session (`0` = unlimited). */
  maxPages: z.number().int().nonnegative().optional(),
  /** Hard cap on browser wall-clock per session, in seconds (`0` = unlimited). */
  maxWallClockSeconds: z.number().int().nonnegative().optional(),
  /** Hard cap on bytes transferred per session (`0` = unlimited). */
  maxBandwidthBytes: z.number().int().nonnegative().optional(),
  /** When non-empty, navigation is restricted to these domains (exact or `*.` wildcard). */
  allowlist: z.array(z.string()).optional(),
  /** Domains the browser may never reach (exact or `*.` wildcard) — checked first, for reads and writes. */
  denylist: z.array(z.string()).optional(),
});

/**
 * Teams / RBAC policy (#151, ADR-0151). Non-secret. `enabled` gates whether workspace roles are
 * enforced on #13 approval clearing. Default **off** (`enabled: false`) so a deployment that sets
 * nothing keeps today's "any human member clears" behavior — enabling can only tighten, never weaken
 * (a member with no role row is still allowed; an owner must assign roles to actually restrict).
 */
export const rbacSchema = z.object({
  /** The role-enforcement flag — default OFF (any human member clears approvals). */
  enabled: z.boolean().optional(),
});

/**
 * Automations policy (#147, ADR-0147). All **non-secret** knobs for the scheduled/webhook agent-task
 * loop. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets
 * nothing fires no scheduled runs (creating automations is still allowed — they simply never tick).
 * `maxRunsPerWindow`/`windowMinutes` are the per-tenant rate limit; `maxPerWorkspace` caps definitions.
 */
export const automationsSchema = z.object({
  /** The automations-tick flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Hard cap on runs launched per workspace inside `windowMinutes` (the rate limit). */
  maxRunsPerWindow: z.number().int().nonnegative().optional(),
  /** The rate-limit window, in minutes. */
  windowMinutes: z.number().int().positive().optional(),
  /** Hard cap on automation definitions a workspace may create. */
  maxPerWorkspace: z.number().int().positive().optional(),
});

/**
 * YC Startup Constitution policy (#146, ADR-0146). All **non-secret** knobs for the enforced
 * constitution. Every field is optional and defaults to **off** (`enabled: false`) so a deployment
 * that sets nothing keeps today's behavior — no venture decision is scored or gated.
 */
export const constitutionSchema = z.object({
  /** Master flag for constitution scoring + the Article I love-gate — default OFF. */
  enabled: z.boolean().optional(),
  /** Article I: minimum distinct unaffiliated paying-intent signals a B2B venture needs to FUND. */
  loveMinSignals: z.number().int().nonnegative().optional(),
  /** Article VIII pricing ladder: coarse increment (%) when deal-loss is low. */
  pricingCoarseStepPct: z.number().min(0).max(100).optional(),
  /** Article VIII pricing ladder: fine increment (%) as deal-loss approaches the ceiling. */
  pricingFineStepPct: z.number().min(0).max(100).optional(),
  /** Article VIII pricing ladder: deal-loss (%) at/above which the ladder holds and flags. */
  pricingDealLossCeilingPct: z.number().min(0).max(100).optional(),
});

/**
 * Fleet skills + semantic layer + eval policy (#155, ADR-0155). One block read by BOTH the semantic-layer
 * caps (freshness ceiling) and the eval caps (regression tolerance + the proactive eval-tick flag). Every
 * field is optional and defaults **OFF**: a deployment that sets nothing surfaces the metric catalog
 * read-only and runs no proactive eval maintenance — reads (answering a metric, listing the catalog) stay
 * always-on and tenant-scoped, `enabled` gates only the proactive eval tick + flywheel feed.
 */
export const fleetSchema = z.object({
  /** The proactive eval-maintenance flag — default OFF (reads always work). */
  enabled: z.boolean().optional(),
  /** Hours after which a metric answer is flagged stale (freshness ceiling). */
  freshnessMaxAgeHours: z.number().nonnegative().optional(),
  /** Allowed pass-rate slip (0–1) before an eval run counts as a regression that feeds the #117 flywheel. */
  evalRegressionTolerance: z.number().min(0).max(1).optional(),
});

/**
 * Workspace catalog policy (#152, ADR-0152). The structured registry of marketing assets agents read
 * for context. Every field is optional and defaults **off** (`enabled: false`) so a deployment that
 * sets nothing exposes no catalog (reads + writes are gated until an owner opts in). `maxEntries` caps
 * how many assets a workspace may register.
 */
export const catalogSchema = z.object({
  /** The catalog feature flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Hard cap on catalog entries a workspace may register. */
  maxEntries: z.number().int().positive().optional(),
});

/**
 * Visual workflow builder policy (#152, ADR-0152). All **non-secret** knobs for the trigger → condition
 * → action loop (the generalization of #147 automations). Every field is optional and defaults **off**
 * (`enabled: false`) so a deployment that sets nothing fires no workflow (creating one is still allowed
 * — it simply never ticks). `maxRunsPerWindow`/`windowMinutes` are the per-tenant firings-per-day cap;
 * `maxPerWorkspace` caps definitions; `maxActionsPerRun` bounds a single firing's fan-out.
 */
export const workflowsSchema = z.object({
  /** The workflows-tick flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Hard cap on firings per workspace inside `windowMinutes` (the firings-per-day rate limit). */
  maxRunsPerWindow: z.number().int().nonnegative().optional(),
  /** The rate-limit window, in minutes (default 1440 = one day). */
  windowMinutes: z.number().int().positive().optional(),
  /** Hard cap on workflow definitions a workspace may create. */
  maxPerWorkspace: z.number().int().positive().optional(),
  /** Hard cap on actions executed in a single firing. */
  maxActionsPerRun: z.number().int().positive().optional(),
});

/**
 * Self-Shipping Loop policy (#172, ADR-0172). All **non-secret** knobs for the build→review→merge loop.
 * Every field is optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing
 * dispatches no builds, reviews nothing, and auto-merges nothing — recording an agent-ok issue + reading
 * the loop's runs stay available (harmless, tenant-scoped). `enabled` gates the proactive tick AND every
 * auto action. `maxConcurrentBuilds` is the hard in-flight build cap; `maxReviewRounds` bounds reviewer
 * FAIL→revise rounds before escalation; `maxDiffFiles`/`maxDiffLines` are the auto-merge size cap (0 = no
 * cap on that axis); `protectedPaths` REPLACES the built-in gate/policy/billing/secrets list that forces
 * human review (omit to keep the safe defaults; never auto-merge a PR touching one).
 */
export const buildLoopSchema = z.object({
  /** The self-shipping-loop flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Hard cap on concurrent in-flight build sessions per workspace (0 = never dispatch). */
  maxConcurrentBuilds: z.number().int().nonnegative().optional(),
  /** Max reviewer FAIL→revise rounds before a run escalates to the owner. */
  maxReviewRounds: z.number().int().nonnegative().optional(),
  /** Auto-merge size cap: max files changed (0 = no file cap). */
  maxDiffFiles: z.number().int().nonnegative().optional(),
  /** Auto-merge size cap: max total changed lines (0 = no line cap). */
  maxDiffLines: z.number().int().nonnegative().optional(),
  /** Protected paths that force human review (replaces the built-in gate/policy/billing/secrets list). */
  protectedPaths: z.array(z.string()).optional(),
});

/**
 * Slack-native integration policy (#170, ADR-0170). All **non-secret** knobs for the Slack surface
 * (the bot token + signing secret live in the #68 sealed vault, never in config). Every field is
 * optional and defaults to **off**: a deployment that sets nothing keeps today's behavior — inbound
 * Slack webhooks still 503 until a workspace connects, and no proactive digest DM is sent. `enabled`
 * gates the proactive digest tick; the mention bridge + approval buttons work whenever a workspace is
 * connected (they are inbound-triggered, not proactive). `digestEnabled` is the daily-DM switch.
 */
export const slackSchema = z.object({
  /** Master flag for the proactive Slack surface (the digest tick) — default OFF. */
  enabled: z.boolean().optional(),
  /** Send the daily fleet digest as an owner DM — default OFF. */
  digestEnabled: z.boolean().optional(),
});

/**
 * Founder Briefings policy (#173, ADR-0173). All **non-secret** knobs for the reporting layer that pushes
 * the daily brief + weekly founder report to the owner and orders the decision queue. Every field is
 * optional and defaults to **off** (`enabled: false`) so a deployment that sets nothing delivers nothing
 * and runs no tick — the read routes still render a brief on demand (harmless, tenant-scoped). `enabled`
 * is the master switch for delivery + the tick; `daily`/`weekly` independently toggle each digest. The
 * `staleLevel*Hours` thresholds parameterize the pure escalation ladder (a stale owner-decision re-notifies
 * on a rising schedule); `maxBriefWords` is the daily brief's "< 200 words" budget.
 */
export const briefingsSchema = z.object({
  /** The delivery + tick flag — default OFF. */
  enabled: z.boolean().optional(),
  /** Deliver the daily brief (when enabled) — default true. */
  daily: z.boolean().optional(),
  /** Deliver the weekly founder report (when enabled) — default true. */
  weekly: z.boolean().optional(),
  /** Decision age (hours) at/above which it is level-1 stale. */
  staleLevel1Hours: z.number().int().positive().optional(),
  /** Decision age (hours) at/above which it is level-2 stale. */
  staleLevel2Hours: z.number().int().positive().optional(),
  /** Decision age (hours) at/above which it is level-3 stale (critical — the owner is the blocker). */
  staleLevel3Hours: z.number().int().positive().optional(),
  /** Hard word budget for the daily brief (default 200). */
  maxBriefWords: z.number().int().positive().optional(),
  /** Hard word budget for the weekly digest (default 400). */
  maxReportWords: z.number().int().positive().optional(),
  /** Top customer-voice signals surfaced in the weekly report. */
  digestVoiceLimit: z.number().int().nonnegative().optional(),
  /** Backlog items surfaced in the weekly report. */
  backlogLimit: z.number().int().nonnegative().optional(),
  /** Owner daily attention budget — the premortem top-N (#200 §5, default 3). */
  attentionBudget: z.number().int().positive().optional(),
  /** Latency (seconds) under which an approval counts as rubber-stamped (#200 §5, default 60). */
  rubberStampSeconds: z.number().int().nonnegative().optional(),
});

/**
 * External account onboarding policy (#192, ADR-0192). All **non-secret** knobs for the human-once setup
 * flow (the per-service keys live in the #192 sealed vault, never in config). Every field is optional and
 * defaults to **off** (`enabled: false`): a deployment that sets nothing keeps today's behavior — the
 * `ExternalSecretsResolver` injects nothing and the connect / DNS-configure writes 409. `enabled` is the
 * master switch (the owner workspace opts in first); `dnsProvider` selects the DNS backend (`dryrun`
 * default — no network); `defaultRotationDays` is the rotation reminder applied when a connect omits one.
 */
export const onboardingSchema = z.object({
  /** Master flag for credential injection + the connect/DNS writes — default OFF. */
  enabled: z.boolean().optional(),
  /** Default rotation-reminder age (days) when a connect doesn't specify one. 0 = no reminder. */
  defaultRotationDays: z.number().int().nonnegative().optional(),
  /** DNS provider kind (`dryrun` default — no network). */
  dnsProvider: z.string().optional(),
});

/**
 * Real-world tool surface policy (#231, ADR-0231). The flags that turn the fleet's gated, recorded-only
 * real-world tools (publish/send/post/...) into actions that touch the world. Default OFF: the publish
 * provider stays `dryrun` (a non-reachable URL, no network) until an owner opts in.
 */
export const realworldSchema = z.object({
  /** Master flag for the real-world tool surface — default OFF. */
  enabled: z.boolean().optional(),
  /** Publish provider kind (`dryrun` default — no network; `github_pages` publishes a live URL). */
  publishProvider: z.string().optional(),
  /**
   * Self-publish-to-ipop.ai provider kind (#250): `dryrun` (default — no network, returns a fake PR url)
   * or `github` (opens a real PR against the configured site repo via the GitHub REST API). ipop owns the
   * site repo, so the token is a server env var (`REALWORLD_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN`) — no
   * third-party OAuth. Opening a PR is autonomous (money-free + reversible); merge/deploy stays a human gate.
   */
  sitePrProvider: z.string().optional(),
  /** The ipop site repo the fleet commits content to, as `owner/repo` (#250). Required for the `github` provider. */
  siteRepo: z.string().optional(),
  /** Base branch the PR targets (default `main`). */
  siteBaseBranch: z.string().optional(),
  /** Directory inside the repo new content files are committed under (default `content/blog`). */
  siteContentDir: z.string().optional(),
  /**
   * Image generation provider kind (#271): `dryrun` (default — renders a deterministic on-brand SVG
   * locally, no network/spend) or a future live external image API. Image generation is a fleet
   * operating cost (not a #243 money action), so it is autonomous; the surface still stays default-OFF
   * via the master `enabled` flag.
   */
  imageProvider: z.string().optional(),
});

/**
 * Outreach engine policy (#225, ADR-0225). The flags behind the signal-triggered, owner-gated outreach
 * engine: composing + parking messages is always available, but `enabled` gates the proactive posture and
 * `sendProvider` selects the (recorded-only by default) sender. `perChannelDailyCap` is the per-channel
 * rate ceiling (premortem #200: deliverability/brand). Default OFF: nothing is sent without the owner.
 */
export const outreachSchema = z.object({
  /** Master flag for the outreach engine's proactive posture — default OFF. */
  enabled: z.boolean().optional(),
  /** Send provider kind (`dryrun` default — recorded-only, no network). */
  sendProvider: z.string().optional(),
  /** Per-channel daily send cap (deliverability/brand protection). */
  perChannelDailyCap: z.number().int().positive().optional(),
});

/**
 * Reach — autonomous outbound demand-gen department policy (#280, ADR-0280). Default OFF: with nothing set
 * the engine still composes + dedupes, but its sender is `dryrun` (recorded-only, no network) and its only
 * data source is the free `mock` provider, so it spends nothing and sends nothing. `prospectSource` picks
 * the data provider (a PAID one — clay/lusha/vibe — turns prospect search into a money-gated `data.credit_spend`
 * action; `mock` is free + autonomous). `perDomainDailyCap` is the per-sending-domain rate ceiling that makes
 * the autonomous email send safe (premortem #200 §4 deliverability bound). `batchSize` caps prospects per run.
 * Sending a marketing message is NOT a money action, so email auto-send is autonomous under the cap +
 * suppression + the CAN-SPAM/GDPR footer fields. `ownerWorkspaceId` scopes the owner-first rollout.
 */
export const reachSchema = z.object({
  /** Master flag for the proactive outbound posture — default OFF. */
  enabled: z.boolean().optional(),
  /** Prospect data provider: `mock` (free, default) | `clay` | `lusha` | `vibe` (paid → money-gated search). */
  prospectSource: z.string().optional(),
  /** Email send provider kind (`dryrun` default — recorded-only, no network egress). */
  sendProvider: z.string().optional(),
  /** Per-sending-domain daily send cap (deliverability bound for the autonomous channel). */
  perDomainDailyCap: z.number().int().positive().optional(),
  /** Max prospects sourced + processed per cron batch. */
  batchSize: z.number().int().positive().optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
  /** CAN-SPAM footer: the sending brand / legal entity name. */
  brandName: z.string().optional(),
  /** CAN-SPAM footer: physical postal address of the sending entity. */
  postalAddress: z.string().optional(),
  /** CAN-SPAM/RFC-8058 unsubscribe URL (a token is appended per recipient). */
  unsubscribeUrl: z.string().optional(),
});

/**
 * SEO rank-tracking policy (#294, ADR-0294). Governs the proactive provider FETCH only — recording an
 * external rank receipt that arrives from outside (a webhook / GSC export / owner paste) is always
 * allowed. Default OFF + `dryrun` provider, so an un-configured workspace fetches nothing and the SEO
 * proof tile stays "not connected" rather than showing a self-reported rank (premortem #200 §2).
 */
export const seoSchema = z.object({
  /** Master flag for the proactive rank FETCH — default OFF (a real provider costs a credential / money). */
  enabled: z.boolean().optional(),
  /** Rank-data provider: `dryrun` (default, reports nothing) | `search_console` | `serpapi` | `dataforseo`. */
  provider: z.string().optional(),
  /** Default search market/country code when an observation omits it (e.g. 'us'). */
  defaultCountry: z.string().optional(),
  /** The target keywords to track (structural data — never instructions). */
  targetKeywords: z.array(z.string()).optional(),
  /** The owner's own workspace id (the owner-first rollout marker). */
  ownerWorkspaceId: z.string().optional(),
});

/**
 * Analytics auto-install + read policy (#270, ADR-0270). Lens (the analytics department, #123) can't report
 * a real number until an analytics tag is on the site. This block lets ipop auto-install the tag and read
 * the metrics so the owner does ZERO tag/code work. Default OFF + `dryrun` provider, owner-workspace-first
 * (mirrors `seo`/`delivery`): an un-configured workspace installs nothing and reads nothing — the founder
 * console keeps reading the internal #102 funnel exactly as today. A real GA4/Plausible read is selected by
 * `provider`; the vendor credential lives in the #192 / #267 vault, never here.
 */
export const analyticsSchema = z.object({
  /** Master flag for the auto-install + read layer — default OFF (the funnel-only tile stays the behavior). */
  enabled: z.boolean().optional(),
  /** Restrict the layer to the owner workspace (default true). Set false to broaden to all tenants. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — the layer rolls out owner-workspace-first. */
  ownerWorkspaceId: z.string().optional(),
  /** Read provider: `dryrun` (default, reports nothing) | `ga4` | `plausible`. */
  provider: z.string().optional(),
  /** The GA4 measurement id / Plausible domain to inject (empty ⇒ a documented placeholder, never a live tag). */
  measurementId: z.string().optional(),
});

/**
 * Acquisition execution policy (#189, ADR-0189). The flags that turn the marketing fleet's queued,
 * recorded-only `external.send` actions into REAL campaigns — ads spend, email sends, social posts,
 * SEO publishing. Every field is optional and defaults to **off**: a deployment that sets nothing keeps
 * today's behavior exactly (the `external.send` executor stays recorded-only, no network egress). The
 * per-channel flags (`ads`/`email`/`social`/`seo`) gate REAL execution on each channel independently —
 * a channel only ever leaves the building once the owner connects its provider (#192 vault) AND its
 * flag is on. `autoSend` is the separate, stricter switch for letting an earned venture send WITHOUT a
 * human #13 yes, within `*WindowCap` pre-commitment bounds (premortem #200 §4); it is OFF by default
 * and owner-workspace-first. `ownerWorkspaceId` scopes the owner-first rollout. Footer fields supply
 * the CAN-SPAM/GDPR footer enforced in code.
 */
export const acquisitionSchema = z.object({
  /** Master flag for the real-send dispatcher — default OFF (recorded-only stays the behavior). */
  enabled: z.boolean().optional(),
  /** Real ad spend execution within an owner-approved envelope. Default OFF. */
  ads: z.boolean().optional(),
  /** Real email sending (ESP). Default OFF. */
  email: z.boolean().optional(),
  /** Real social publishing (X/LinkedIn). Default OFF. */
  social: z.boolean().optional(),
  /** Real SEO publishing to venture sites (#153). Default OFF. */
  seo: z.boolean().optional(),
  /** Allow an EARNED venture to send without a human #13 yes, within caps. Default OFF. */
  autoSend: z.boolean().optional(),
  /** The owner's own workspace id — auto-send rolls out owner-workspace-first. */
  ownerWorkspaceId: z.string().optional(),
  /** Pre-committed per-window cap on autonomous email sends (the bound for an irreversible channel). */
  emailWindowCap: z.number().int().nonnegative().optional(),
  /** Pre-committed per-window cap on autonomous social posts. */
  socialWindowCap: z.number().int().nonnegative().optional(),
  /** Max publish-retry attempts before a social failure surfaces to the brief. */
  maxRetries: z.number().int().positive().optional(),
  /** Ads provider kind the factory selects (`dryrun` default — no network). */
  adsProvider: z.string().optional(),
  /** ESP (email) provider kind (`dryrun` default). */
  espProvider: z.string().optional(),
  /** Social provider kind (`dryrun` default). */
  socialProvider: z.string().optional(),
  /** CAN-SPAM footer: the sending brand / legal entity name. */
  brandName: z.string().optional(),
  /** CAN-SPAM footer: physical postal address of the sending entity. */
  postalAddress: z.string().optional(),
  /** CAN-SPAM/RFC-8058 unsubscribe URL. */
  unsubscribeUrl: z.string().optional(),
});

/**
 * Deliverable delivery policy (#295, ADR-0295). The flags that turn an APPROVED `agent.deliverable` review
 * card into a REAL ship — a live published page (Scout/SEO, Quill/content), a social post (Echo), an email
 * (Postmark). Every field is optional and defaults to **off**: a deployment that sets nothing keeps today's
 * behavior exactly (approving a deliverable is a pure acknowledgement, nothing ships).
 *
 * The gate is two-pronged and DEFAULT-OFF, owner-workspace-first: the master `enabled` flag must be on AND
 * the workspace must be in scope (`ownerWorkspaceOnly` defaults true ⇒ only `ownerWorkspaceId` ships).
 * Turning `enabled` on WITHOUT naming the owner workspace ships to nobody (the safest default). The
 * per-channel flags (`publish`/`social`/`email`) gate each channel independently. `publishProvider` selects
 * the live-page provider (`dryrun` default — not reachable; `github_pages` publishes a real URL). No
 * credentials/Stripe here — social/email ride the #189 dry-run providers (a real adapter is a future ADR).
 */
export const deliverySchema = z.object({
  /** Master flag for approve→publish delivery — default OFF (acknowledgement-only stays the behavior). */
  enabled: z.boolean().optional(),
  /** Restrict live delivery to the owner workspace (default true). Set false to broaden to all tenants. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — delivery rolls out owner-workspace-first. */
  ownerWorkspaceId: z.string().optional(),
  /** Ship content/SEO deliverables as a live published page. Default OFF. */
  publish: z.boolean().optional(),
  /** Ship social deliverables as a post (dry-run until a real adapter is connected). Default OFF. */
  social: z.boolean().optional(),
  /** Ship email deliverables (dry-run, no recipients, until a real ESP adapter is connected). Default OFF. */
  email: z.boolean().optional(),
  /** Live-page publish provider kind (`dryrun` default — no network; `github_pages` publishes a live URL). */
  publishProvider: z.string().optional(),
});

/**
 * SkillOpt-Sleep self-improvement policy (#283, ADR-0283). The flags behind the offline cycle that lets a
 * department agent mine its own recurring tasks and PROPOSE a bounded edit to its skill doc. Default OFF,
 * owner-workspace-first: a deployment that sets nothing runs no cycle and stages nothing. Even when
 * `enabled`, an `ownerWorkspaceOnly` deployment (the default) only runs for the named owner workspace. No
 * credentials/money here — a proposal is staged in the #13 queue and adopted only by the owner; the loop
 * never edits a doc. The numeric knobs tune mining/gate/proposal bounds (`skillopt/caps.ts` fills defaults).
 */
export const skilloptSchema = z.object({
  /** Master flag for the offline self-improvement cycle — default OFF. */
  enabled: z.boolean().optional(),
  /** Restrict the loop to the owner workspace (default true). Set false to run for all tenants. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — the loop rolls out owner-workspace-first. */
  ownerWorkspaceId: z.string().optional(),
  /** Minimum occurrences for a task to count as recurring (default 3). */
  minRecurrence: z.number().int().positive().optional(),
  /** Minimum held-out replay size for a validation reading to count (default 5). */
  minSampleSize: z.number().int().positive().optional(),
  /** Minimum relative improvement over baseline to stage a proposal (default 0.05). */
  minImprovementRatio: z.number().nonnegative().optional(),
  /** Max chars for a single bounded skill-doc append (default 600). */
  maxAppendChars: z.number().int().positive().optional(),
});

/**
 * Central provisioning policy (#267, ADR-0267). ipop holds the paid data/posting/ads API keys CENTRALLY
 * and bills the cost into the plan, so a customer never provisions or sees a key. Every field is optional
 * and defaults to **off, owner-workspace-first** (mirrors `delivery`): a deployment that sets nothing
 * provisions nothing — every capability resolves to the free mock path and no central vault is read.
 * Turning `enabled` on WITHOUT naming the owner workspace provisions to NObody (the safest default).
 *
 * No credential lives here — the central keys live in the OWNER workspace's #192 vault under
 * `central:<provider>`. `providerByCapability` maps a capability id → a provider id (NAME only, never a
 * key), so a per-department PR activates a real provider without a code change. The customer's OWN spend
 * (ad budget, email tier) is NOT controlled here — it stays a #13 money-gated `provisioning.customer_spend`.
 */
export const provisioningSchema = z.object({
  /** Master switch for central provisioning — default OFF. */
  enabled: z.boolean().optional(),
  /** Restrict provisioning to the owner workspace (default true). False ⇒ broaden to all tenants. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — ALSO the vault tenant the `central:<provider>` keys are read from. */
  ownerWorkspaceId: z.string().optional(),
  /** capability id → provider id (name only, never a key), e.g. `{ keyword_data: "dataforseo" }`. */
  providerByCapability: z.record(z.string()).optional(),
});

/**
 * ipop hosted publishing policy (#266, ADR-0266). The non-secret knobs for the multi-tenant customer blog +
 * landing pages ipop hosts (zero repo, zero deploy the customer sees). DEFAULT-OFF, owner-workspace-first —
 * exactly like {@link deliverySchema}: `enabled` must be on AND the workspace in scope (`ownerWorkspaceOnly`
 * defaults true ⇒ only `ownerWorkspaceId` hosts). The HARD constraint (nothing goes live without an explicit
 * owner approval) is enforced structurally in the service, not by a flag here. No credentials/Stripe — a free
 * ipop subdomain hosts immediately; a custom domain is served only once the #264 DNS flow verifies it.
 */
export const hostedSitesSchema = z.object({
  /** Master flag for hosted publishing — default OFF (the feature is fully dark until an owner opts in). */
  enabled: z.boolean().optional(),
  /** Restrict hosting to the owner workspace (default true). Set false to broaden to all tenants. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** The owner's own workspace id — hosting rolls out owner-workspace-first. */
  ownerWorkspaceId: z.string().optional(),
  /** Base host for free ipop subdomains (`<sub>.<baseHost>`); defaults to `sites.ipop.app`. */
  baseHost: z.string().optional(),
});

/**
 * Finance Ledger policy (#194, ADR-0194). All **non-secret** knobs for the accounting layer that posts
 * external receipts into a per-venture ledger, closes the monthly books, and forecasts runway. Every
 * field is optional and defaults to **off** (`enabled: false`), owner-workspace-first: a deployment that
 * sets nothing runs no posting/close tick and the read routes answer 409. Even enabled, nothing here can
 * move money (the `finance.disbursement` action stays human-gated + recorded-only).
 */
export const financeSchema = z.object({
  /** Master switch for the posting/close tick + the read surface — default OFF. */
  enabled: z.boolean().optional(),
  /** Lookback (months) for the runway burn-rate + recent-periods forecast basis (default 6). */
  lookbackMonths: z.number().int().positive().optional(),
  /** Cash floor (cents) the runway/recommendation treat as the breach line (default 0). */
  floorCents: z.number().int().nonnegative().optional(),
  /** At/below this many post-spend runway days a money decision is recommended `caution` (default 30). */
  cautionRunwayDays: z.number().int().positive().optional(),
  /** Months-to-breach at/below which the runway header reads `at_risk` (default 3). */
  atRiskMonths: z.number().int().positive().optional(),
  /** Max ledger rows a single read/CSV export returns (default 500). */
  ledgerLimit: z.number().int().positive().optional(),
});

/**
 * Venture monetization rails (#188, ADR-0188). Default OFF per workspace AND per venture: even when
 * `enabled`, a venture can only charge once the owner connects its OWN Stripe account (the #192 vault,
 * keyed `stripe:<ventureIdeaId>`) — never ipop's key. Drafting plans is free; activating/re-pricing/payout
 * changes always queue as #13 MONEY decisions; revenue is counted only from signature-verified receipts.
 */
export const monetizationSchema = z.object({
  /** Master switch for drafting/activation/webhook ingestion — default OFF. */
  enabled: z.boolean().optional(),
  /** Restrict monetization to the owner workspace (default true), like the #187 factory. */
  ownerWorkspaceOnly: z.boolean().optional(),
  /** Default ISO 4217 currency for drafts when one is not specified (default "usd"). */
  defaultCurrency: z.string().length(3).optional(),
  /** Webhook signature replay tolerance in seconds (default 300). */
  webhookToleranceSec: z.number().int().positive().optional(),
  /** Max plans/experiments a single read returns (default 200). */
  listLimit: z.number().int().positive().optional(),
});

export const settingsSchema = z.object({
  /** Enterprise data-privacy mode: when on, off-platform data egress is disabled (#58). */
  dataPrivacyMode: z.boolean().optional(),
  /** Files copied into each new session workspace on launch (relative to cwd or absolute). */
  filesToCopy: z.array(z.string()).optional(),
  /** Base dir under which per-session working dirs are created (`<workspaceRoot>/<sessionId>`). */
  workspaceRoot: z.string().optional(),
  /** Project slash commands keyed by name (#57): `/<name>` expands to its prompt template. */
  slashCommands: z.record(z.string(), slashCommandSchema).optional(),
  /** Canonical MCP servers keyed by name (#57), synced to each harness's config format. */
  mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  /** Skill names/paths (#57) the agent should carry across harnesses. */
  skills: z.array(z.string()).optional(),
  /** The Run tab's run command (#56): how to start the session's app for in-app preview. */
  run: runSchema.optional(),
  /** Deploy-to-live-URL settings (#73): how to build + deploy the session's app. */
  deploy: deploySchema.optional(),
  /** Model/provider selection policy (#52): which providers/models a tenant allows + defaults. */
  models: modelsSchema.optional(),
  /** Auto model-selection policy (convene-llm-gateway): per-tenant on switch + per-call cost ceiling. */
  autoModel: autoModelSchema.optional(),
  /** Cloud-scale policy (#71): warm pool, concurrency caps, regions, cost/budget caps. */
  scale: scaleSchema.optional(),
  /** Stripe revenue-rails settings (#98): backend, currency, secret-var names (no values). */
  billing: billingSchema.optional(),
  /** Venture-loop policy (#96): the YC-fundability admission gate + decision thresholds. */
  venture: ventureSchema.optional(),
  /** Fleet-watchdog policy (#105): the stalled-session supervisor + bounded restart policy. */
  watchdog: watchdogSchema.optional(),
  /** SRE Loop policy (#112): per-service SLOs + the agent-on-call alert/incident loop. */
  sre: sreSchema.optional(),
  /** Self-Healing Ops policy (#193): per-venture monitoring + bounded auto-remediation (default OFF). */
  selfHealing: selfHealingSchema.optional(),
  /** Reliability surface policy (#148): owner paging, chat-native incidents, AI investigation, status page. */
  reliability: reliabilitySchema.optional(),
  /** Evidence-Priced Autonomy policy (#119): the gate pricer that auto-relaxes/re-tightens #95 rules. */
  gatePricing: gatePricingSchema.optional(),
  /** Self-healing flywheel policy (#117): the failure→issue→fix loop + its bounds. */
  flywheel: flywheelSchema.optional(),
  /** Self-QA loop policy (#171): the synthetic-user E2E QA pass that files its own bug issues (default OFF). */
  selfqa: selfqaSchema.optional(),
  /** Marketing department fleet policy (#123): seed-on-signup + welcome tasks (default OFF). */
  marketing: marketingSchema.optional(),
  /** Outcome Verifiers policy (#106): the measured-gate runner + escalation (default OFF). */
  verifiers: verifiersSchema.optional(),
  /** Deliverable Verification Layer policy (#191): independent verifier gate on deliverables (default OFF). */
  verification: verificationSchema.optional(),
  /** Growth-loop policy (#102): distribution instrumentation + funnel scoring (default OFF). */
  growth: growthSchema.optional(),
  /** Decision-maker resolver policy (#223): account -> buyer brief, quarantined enrichment (default OFF). */
  decisionMaker: decisionMakerSchema.optional(),
  /** Insight Miner policy (#100): the evidence-mining loop feeding the #96 SOURCE stage (default OFF). */
  insight: insightSchema.optional(),
  /** Moat-accrual policy (#103): moat scoring weights + stagnation-flagging window (default OFF). */
  moat: moatSchema.optional(),
  /** Customer Voice Loop policy (#114): post-launch support/feedback/churn loop (default OFF). */
  voice: voiceSchema.optional(),
  /** Support Desk policy (#190): bounded autonomous answering + KB + SLA + escalation (default OFF). */
  supportDesk: supportDeskSchema.optional(),
  /** Legal & Compliance pack policy (#196): per-venture legal docs + send-layer CAN-SPAM/CASL/GDPR (default OFF). */
  legal: legalSchema.optional(),
  /** Portfolio Lifecycle Loop policy (#107): launched-venture review thresholds + weights (default OFF). */
  portfolio: portfolioSchema.optional(),
  /** Product Planning Loop policy (#115): RICE backlog → specs → proposed sessions (default OFF). */
  planning: planningSchema.optional(),
  /** Venture Memory & Planning policy (#197): per-venture memory + weekly planning loop (default OFF). */
  ventureMemory: ventureMemorySchema.optional(),
  /** Venture Factory policy (#187): opportunity scanner → validation → bootstrap pipeline (default OFF). */
  ventureFactory: ventureFactorySchema.optional(),
  /** Venture Deploys policy (#195): per-venture provisioning + release pipeline (default OFF). */
  ventureDeploys: ventureDeploysSchema.optional(),
  /** Per-agent scoped credentials policy (#151): the allowlist matrix (key NAMES only, default OFF). */
  credentialScopes: credentialScopesSchema.optional(),
  /** Egress domain allowlist policy (#151) for cloud agent sessions (default OFF). */
  egress: egressSchema.optional(),
  /** Teams/RBAC policy (#151): enforce workspace roles on approval clearing (default OFF). */
  rbac: rbacSchema.optional(),
  /** Automations policy (#147): scheduled/webhook agent tasks + per-tenant run caps (default OFF). */
  automations: automationsSchema.optional(),
  /** YC Startup Constitution policy (#146): decision scoring + Article I love-gate (default OFF). */
  constitution: constitutionSchema.optional(),
  /** Fleet skills + semantic layer + eval policy (#155): freshness ceiling + eval regression tolerance (default OFF). */
  fleet: fleetSchema.optional(),
  /** Workspace catalog policy (#152): the marketing-asset registry feature flag + entry cap (default OFF). */
  catalog: catalogSchema.optional(),
  /** Visual workflow builder policy (#152): trigger→condition→action firings + per-day caps (default OFF). */
  workflows: workflowsSchema.optional(),
  /** Self-Shipping Loop policy (#172): the build→review→auto-merge-within-guardrails loop (default OFF). */
  buildLoop: buildLoopSchema.optional(),
  /** Slack-native integration policy (#170): the digest tick switch (the surface is default OFF). */
  slack: slackSchema.optional(),
  /** Founder Briefings policy (#173): daily brief + weekly P&L report + decision queue delivery (default OFF). */
  briefings: briefingsSchema.optional(),
  /** Agent browser runtime policy (#174): Playwright sessions + per-session caps + domain lists (default OFF). */
  browser: browserSchema.optional(),
  /** External account onboarding policy (#192): human-once setup + agent credential injection (default OFF). */
  onboarding: onboardingSchema.optional(),
  /** Real-world tool surface policy (#231): gated publish/send/post + publish provider (default OFF). */
  realworld: realworldSchema.optional(),
  /** Outreach engine policy (#225): signal-triggered, owner-gated, externally-measured sends (default OFF). */
  outreach: outreachSchema.optional(),
  /** Acquisition execution policy (#189): real ads/email/social/SEO sends + auto-send caps (default OFF). */
  acquisition: acquisitionSchema.optional(),
  /** Deliverable delivery policy (#295): approve→publish ship of `agent.deliverable` drafts (default OFF). */
  delivery: deliverySchema.optional(),
  /** Central provisioning policy (#267): ipop-held paid data/posting/ads keys billed into the plan (default OFF). */
  provisioning: provisioningSchema.optional(),
  /** ipop hosted publishing policy (#266): multi-tenant customer blogs + landing pages (default OFF). */
  hostedSites: hostedSitesSchema.optional(),
  /** Finance Ledger policy (#194): per-venture ledger + monthly close + runway forecast (default OFF). */
  finance: financeSchema.optional(),
  /** Venture monetization policy (#188): per-venture pricing drafts + money-gated activation (default OFF). */
  monetization: monetizationSchema.optional(),
  /** Customer Discovery Engine policy (#222): per-venture signal layer + ranked prospect queue (default OFF). */
  discovery: discoverySchema.optional(),
  /** Reach outbound demand-gen policy (#280): pluggable prospect sources + autonomous capped sends (default OFF). */
  reach: reachSchema.optional(),
  /** SEO rank-tracking policy (#294): externally-grounded rank receipts feeding the SEO proof tile (default OFF). */
  seo: seoSchema.optional(),
  /** Analytics auto-install + read policy (#270): ipop installs the tag + reads metrics so Lens can report (default OFF). */
  analytics: analyticsSchema.optional(),
  /** Agent Registry + A2A policy (#282): department-fleet contracts + governed agent-to-agent calls (default OFF). */
  agentRegistry: agentRegistrySchema.optional(),
  /** Agent collaboration policy (#319): provision the subagent-spawn tool so leads can delegate (default OFF, owner-first). */
  agentCollaboration: agentCollaborationSchema.optional(),
  /** Connect-Claude policy (#262): in-app one-click Connect replacing the `claude setup-token` CLI (default OFF). */
  connectClaude: connectClaudeSchema.optional(),
  /** Connect-once live-flow policy (#258 Stage 2): the gated live customer-OAuth connect seam (default OFF). */
  connectOnce: connectOnceSchema.optional(),
  /** SkillOpt-Sleep policy (#283): per-agent offline self-improvement cycle staging #13 proposals (default OFF). */
  skillopt: skilloptSchema.optional(),
  /** Low-commitment signup-entry policy (#300): sample workspace + progressive Google scopes (default OFF). */
  signupEntry: signupEntrySchema.optional(),
  /** Email deliverability + compliance pipeline (#268): Postmark live-send eligibility + rate caps (default OFF). */
  emailDeliverability: emailDeliverabilitySchema.optional(),
});

/** One config layer — a validated partial. */
export type Settings = z.infer<typeof settingsSchema>;
export type SlashCommandConfig = z.infer<typeof slashCommandSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type RunConfig = z.infer<typeof runSchema>;
export type DeployConfig = z.infer<typeof deploySchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type EffortLevel = z.infer<typeof effortLevelSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;
export type AutoModelConfig = z.infer<typeof autoModelSchema>;
export type ScaleConfig = z.infer<typeof scaleSchema>;
export type BillingConfig = z.infer<typeof billingSchema>;
export type VentureConfig = z.infer<typeof ventureSchema>;
export type WatchdogConfig = z.infer<typeof watchdogSchema>;
export type SreConfig = z.infer<typeof sreSchema>;
export type SreServiceConfig = z.infer<typeof sreServiceSchema>;
export type SelfHealingConfig = z.infer<typeof selfHealingSchema>;
export type ReliabilityConfig = z.infer<typeof reliabilitySchema>;
export type GatePricingConfig = z.infer<typeof gatePricingSchema>;
export type FlywheelConfig = z.infer<typeof flywheelSchema>;
export type SelfqaConfig = z.infer<typeof selfqaSchema>;
export type MarketingConfig = z.infer<typeof marketingSchema>;
export type VerifierConfig = z.infer<typeof verifiersSchema>;
export type VerificationConfig = z.infer<typeof verificationSchema>;
export type GrowthConfig = z.infer<typeof growthSchema>;
export type DecisionMakerConfig = z.infer<typeof decisionMakerSchema>;
export type InsightConfig = z.infer<typeof insightSchema>;
export type MoatConfig = z.infer<typeof moatSchema>;
export type VoiceConfig = z.infer<typeof voiceSchema>;
export type SupportDeskConfig = z.infer<typeof supportDeskSchema>;
export type LegalConfig = z.infer<typeof legalSchema>;
export type PortfolioConfig = z.infer<typeof portfolioSchema>;
export type PlanningConfig = z.infer<typeof planningSchema>;
export type VentureMemoryConfig = z.infer<typeof ventureMemorySchema>;
export type VentureFactoryConfig = z.infer<typeof ventureFactorySchema>;
export type VentureDeploysConfig = z.infer<typeof ventureDeploysSchema>;
export type CredentialScopesConfig = z.infer<typeof credentialScopesSchema>;
export type EgressConfig = z.infer<typeof egressSchema>;
export type RbacConfig = z.infer<typeof rbacSchema>;
export type AutomationsConfig = z.infer<typeof automationsSchema>;
export type ConstitutionConfig = z.infer<typeof constitutionSchema>;
export type FleetConfig = z.infer<typeof fleetSchema>;
export type CatalogConfig = z.infer<typeof catalogSchema>;
export type WorkflowsConfig = z.infer<typeof workflowsSchema>;
export type BuildLoopConfig = z.infer<typeof buildLoopSchema>;
export type SlackConfig = z.infer<typeof slackSchema>;
export type BriefingsConfig = z.infer<typeof briefingsSchema>;
export type BrowserConfig = z.infer<typeof browserSchema>;
export type OnboardingConfig = z.infer<typeof onboardingSchema>;
export type RealworldConfig = z.infer<typeof realworldSchema>;
export type OutreachConfig = z.infer<typeof outreachSchema>;
export type AcquisitionConfig = z.infer<typeof acquisitionSchema>;
export type DeliveryConfig = z.infer<typeof deliverySchema>;
export type ProvisioningConfig = z.infer<typeof provisioningSchema>;
export type HostedSitesConfig = z.infer<typeof hostedSitesSchema>;
export type FinanceConfig = z.infer<typeof financeSchema>;
export type MonetizationConfig = z.infer<typeof monetizationSchema>;
export type DiscoveryConfig = z.infer<typeof discoverySchema>;
export type ReachConfig = z.infer<typeof reachSchema>;
export type SeoConfig = z.infer<typeof seoSchema>;
export type AnalyticsConfig = z.infer<typeof analyticsSchema>;
export type AgentRegistryConfig = z.infer<typeof agentRegistrySchema>;
export type AgentCollaborationConfig = z.infer<typeof agentCollaborationSchema>;
export type ConnectClaudeConfig = z.infer<typeof connectClaudeSchema>;
export type ConnectOnceConfig = z.infer<typeof connectOnceSchema>;
export type SkillOptConfig = z.infer<typeof skilloptSchema>;
export type SignupEntryConfig = z.infer<typeof signupEntrySchema>;
export type EmailDeliverabilityConfig = z.infer<typeof emailDeliverabilitySchema>;

/**
 * The free-tier ("trial") scale caps every workspace gets when no paid plan / managed override sets
 * its own `[scale]` (#160). **Deliberately ON by default** — the one config block that is
 * not opt-in — because checkout→caps is not wired yet and a workspace with NO usable tier cannot run
 * agents at all (a fresh/owner workspace would be dead on arrival). `tenantConcurrency: 1` is a real,
 * usable ceiling (one live session at a time); `budgetCents: 500` is a $5/window soft cap that only
 * bites once a `computeRateCentsPerMinute` is configured (rate defaults to 0 → cost 0 → never bites),
 * so it is a forward-looking guardrail, not a blocker. Tunable via `RELOAD_TRIAL_*` (the env base
 * layer); any higher layer that sets `[scale]` (a paid plan's managed override) fully replaces it.
 */
export const TRIAL_SCALE_DEFAULTS = { tenantConcurrency: 1, budgetCents: 500 } as const;

/** The resolved, defaults-applied config consumed by the rest of the server. */
export interface ResolvedConfig {
  dataPrivacyMode: boolean;
  filesToCopy: string[];
  workspaceRoot: string;
  slashCommands: Record<string, SlashCommandConfig>;
  mcpServers: Record<string, McpServerConfig>;
  skills: string[];
  /** The Run tab's run command (#56), or undefined when the deployment configures none. */
  run?: RunConfig;
  /** Deploy settings (#73), or undefined when the deployment hasn't enabled deploy (opt-in → 409). */
  deploy?: DeployConfig;
  /** Model/provider selection policy (#52). A partial whose hard defaults `modelPolicyFromConfig` fills. */
  models: ModelsConfig;
  /** Auto model-selection policy (convene-llm-gateway). Default-off; `{}` ⇒ disabled (today's behavior). */
  autoModel: AutoModelConfig;
  /** Cloud-scale policy (#71). A partial whose hard defaults `resolveScaleCaps` fills. */
  scale: ScaleConfig;
  /** Stripe revenue-rails settings (#98), or undefined when the deployment hasn't enabled billing (→ 409). */
  billing?: BillingConfig;
  /** Venture-loop policy (#96). A partial whose hard defaults `resolveVentureCaps` fills. */
  venture: VentureConfig;
  /** Fleet-watchdog policy (#105). A partial whose hard defaults `resolveWatchdogCaps` fills. */
  watchdog: WatchdogConfig;
  /** SRE Loop policy (#112). A partial whose hard defaults `resolveSreCaps` fills. */
  sre: SreConfig;
  /** Self-Healing Ops policy (#193). A partial whose hard defaults `resolveSelfHealingCaps` fills. */
  selfHealing: SelfHealingConfig;
  /** Reliability surface policy (#148). A partial whose hard defaults `resolveReliabilityCaps` fills. */
  reliability: ReliabilityConfig;
  /** Evidence-Priced Autonomy policy (#119). A partial whose hard defaults `resolveGatePricingCaps` fills. */
  gatePricing: GatePricingConfig;
  /** Self-healing flywheel policy (#117). A partial whose hard defaults `resolveFlywheelCaps` fills. */
  flywheel: FlywheelConfig;
  /** Self-QA loop policy (#171). A partial whose hard defaults `resolveSelfqaCaps` fills. */
  selfqa: SelfqaConfig;
  /** Marketing department fleet policy (#123). A partial whose hard defaults `resolveMarketingCaps` fills. */
  marketing: MarketingConfig;
  /** Outcome Verifiers policy (#106). A partial whose hard defaults `resolveVerifierCaps` fills. */
  verifiers: VerifierConfig;
  /** Deliverable Verification Layer policy (#191). A partial whose hard defaults `resolveVerificationCaps` fills. */
  verification: VerificationConfig;
  /** Growth-loop policy (#102). A partial whose hard defaults `resolveGrowthCaps` fills. */
  growth: GrowthConfig;
  /** Decision-maker resolver policy (#223). A partial whose hard defaults `resolveDecisionMakerCaps` fills. */
  decisionMaker: DecisionMakerConfig;
  /** Insight Miner policy (#100). A partial whose hard defaults `resolveInsightCaps` fills. */
  insight: InsightConfig;
  /** Moat-accrual policy (#103). A partial whose hard defaults `resolveMoatCaps` fills. */
  moat: MoatConfig;
  /** Customer Voice Loop policy (#114). A partial whose hard defaults `resolveVoiceCaps` fills. */
  voice: VoiceConfig;
  /** Support Desk policy (#190). A partial whose hard defaults `resolveSupportDeskCaps` fills. */
  supportDesk: SupportDeskConfig;
  /** Legal & Compliance pack policy (#196). A partial whose hard defaults `resolveLegalCaps` fills. */
  legal: LegalConfig;
  /** Portfolio Lifecycle Loop policy (#107). A partial whose hard defaults `resolvePortfolioCaps` fills. */
  portfolio: PortfolioConfig;
  /** Product Planning Loop policy (#115). A partial whose hard defaults `resolvePlanningCaps` fills. */
  planning: PlanningConfig;
  /** Venture Memory & Planning policy (#197). A partial whose defaults `resolveVentureMemoryCaps` fills. */
  ventureMemory: VentureMemoryConfig;
  /** Venture Factory policy (#187). A partial whose defaults `resolveVentureFactoryCaps` fills. */
  ventureFactory: VentureFactoryConfig;
  /** Venture Deploys policy (#195). A partial whose defaults `resolveVentureDeployCaps` fills. */
  ventureDeploys: VentureDeploysConfig;
  /** Per-agent scoped credentials policy (#151). A partial whose defaults `resolveCredentialMatrix` fills. */
  credentialScopes: CredentialScopesConfig;
  /** Egress domain allowlist policy (#151). A partial whose defaults `resolveEgressPolicy` fills. */
  egress: EgressConfig;
  /** Teams/RBAC policy (#151). A partial whose defaults `resolveRbacConfig` fills. */
  rbac: RbacConfig;
  /** Automations policy (#147). A partial whose hard defaults `resolveAutomationCaps` fills. */
  automations: AutomationsConfig;
  /** YC Startup Constitution policy (#146). A partial whose hard defaults `resolveConstitutionCaps` fills. */
  constitution: ConstitutionConfig;
  /** Fleet skills + semantic + eval policy (#155). A partial whose hard defaults `resolveFleetCaps` fills. */
  fleet: FleetConfig;
  /** Workspace catalog policy (#152). A partial whose hard defaults `resolveCatalogCaps` fills. */
  catalog: CatalogConfig;
  /** Visual workflow builder policy (#152). A partial whose hard defaults `resolveWorkflowCaps` fills. */
  workflows: WorkflowsConfig;
  /** Self-Shipping Loop policy (#172). A partial whose hard defaults `resolveBuildLoopCaps` fills. */
  buildLoop: BuildLoopConfig;
  /** Slack-native integration policy (#170). A partial whose hard defaults `resolveSlackCaps` fills. */
  slack: SlackConfig;
  /** Founder Briefings policy (#173). A partial whose hard defaults `resolveBriefingsCaps` fills. */
  briefings: BriefingsConfig;
  /** Agent browser runtime policy (#174). A partial whose hard defaults `resolveBrowserCaps` fills. */
  browser: BrowserConfig;
  /** External account onboarding policy (#192). A partial whose hard defaults `resolveOnboardingCaps` fills. */
  onboarding: OnboardingConfig;
  /** Real-world tool surface policy (#231). A partial whose hard defaults `resolveRealworldCaps` fills. */
  realworld: RealworldConfig;
  /** Outreach engine policy (#225). A partial whose hard defaults `resolveOutreachCaps` fills. */
  outreach: OutreachConfig;
  acquisition: AcquisitionConfig;
  /** Deliverable delivery policy (#295). A partial resolved by `resolveDeliveryFlags`. */
  delivery: DeliveryConfig;
  /** Central provisioning policy (#267). A partial whose hard defaults `resolveProvisioningCaps` fills. */
  provisioning: ProvisioningConfig;
  /** ipop hosted publishing policy (#266). A partial resolved by `resolveHostedSitesFlags`. */
  hostedSites: HostedSitesConfig;
  /** Finance Ledger policy (#194). A partial whose hard defaults `resolveFinanceCaps` fills. */
  finance: FinanceConfig;
  /** Venture monetization policy (#188). A partial whose hard defaults `resolveMonetizationCaps` fills. */
  monetization: MonetizationConfig;
  /** Customer Discovery Engine policy (#222). A partial whose hard defaults `resolveDiscoveryCaps` fills. */
  discovery: DiscoveryConfig;
  /** Reach outbound demand-gen policy (#280). A partial whose hard defaults `resolveReachCaps` fills. */
  reach: ReachConfig;
  /** SEO rank-tracking policy (#294). A partial whose hard defaults `resolveSeoCaps` fills. */
  seo: SeoConfig;
  /** Analytics auto-install + read policy (#270). A partial resolved by `resolveAnalyticsFlags`. */
  analytics: AnalyticsConfig;
  /** Agent Registry + A2A policy (#282). A partial whose hard defaults `resolveAgentRegistryCaps` fills. */
  agentRegistry: AgentRegistryConfig;
  /** Agent collaboration policy (#319). A partial whose hard defaults `resolveAgentCollaborationCaps` fills. */
  agentCollaboration: AgentCollaborationConfig;
  /** Connect-Claude policy (#262). A partial whose hard defaults `resolveConnectClaudeCaps` fills. */
  connectClaude: ConnectClaudeConfig;
  /** Connect-once live-flow policy (#258 Stage 2). A partial whose hard defaults `resolveConnectOnceCaps` fills. */
  connectOnce: ConnectOnceConfig;
  /** SkillOpt-Sleep policy (#283). A partial whose hard defaults `resolveSkillOptCaps` fills. */
  skillopt: SkillOptConfig;
  /** Low-commitment signup-entry policy (#300). A partial whose hard defaults `resolveSignupEntryCaps` fills. */
  signupEntry: SignupEntryConfig;
  /** Email deliverability + compliance pipeline (#268). A partial resolved by `isLiveSendEnabledForWorkspace`. */
  emailDeliverability: EmailDeliverabilityConfig;
}

/**
 * Lowest layer: the built-in defaults (privacy off, no files, local ws root). One intentional
 * exception to "every block defaults off": `scale` carries the trial free tier ({@link TRIAL_SCALE_DEFAULTS},
 * #147) so a fresh workspace can run agents before checkout is wired.
 */
export const CONFIG_DEFAULTS: ResolvedConfig = {
  dataPrivacyMode: false,
  filesToCopy: [],
  workspaceRoot: ".reload/workspaces",
  slashCommands: {},
  mcpServers: {},
  skills: [],
  models: {},
  autoModel: {},
  // #147: the trial free tier is the built-in baseline (default-ON), not an empty/unlimited block.
  scale: { ...TRIAL_SCALE_DEFAULTS },
  venture: {},
  watchdog: {},
  sre: {},
  selfHealing: {},
  reliability: {},
  gatePricing: {},
  flywheel: {},
  selfqa: {},
  marketing: {},
  verifiers: {},
  verification: {},
  growth: {},
  decisionMaker: {},
  insight: {},
  moat: {},
  voice: {},
  supportDesk: {},
  legal: {},
  portfolio: {},
  planning: {},
  ventureMemory: {},
  ventureFactory: {},
  ventureDeploys: {},
  credentialScopes: {},
  egress: {},
  rbac: {},
  automations: {},
  constitution: {},
  fleet: {},
  catalog: {},
  workflows: {},
  buildLoop: {},
  slack: {},
  briefings: {},
  browser: {},
  onboarding: {},
  realworld: {},
  outreach: {},
  acquisition: {},
  delivery: {},
  provisioning: {},
  hostedSites: {},
  finance: {},
  monetization: {},
  discovery: {},
  reach: {},
  seo: {},
  analytics: {},
  agentRegistry: {},
  agentCollaboration: {},
  connectClaude: {},
  connectOnce: {},
  skillopt: {},
  signupEntry: {},
  emailDeliverability: {},
};
