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
 * Portfolio Lifecycle Loop policy (#107, ADR-0107). All **non-secret** knobs for the launched-venture
 * review loop. Every field is optional and defaults to **off** (`enabled: false`) so a deployment that
 * sets nothing keeps today's behavior — reviews still compute/persist on demand (harmless, tenant-scoped)
 * but the Founder Console raises no portfolio attention and no proactive tick runs. SUNSET execution
 * stays #13-gated regardless. The threshold/weight fields parameterize the pure `decidePortfolio` ladder
 * and ARE the per-venture targets the review judges against (the tenant's layered, lockable policy).
 */
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
  /** Reliability surface policy (#148): owner paging, chat-native incidents, AI investigation, status page. */
  reliability: reliabilitySchema.optional(),
  /** Evidence-Priced Autonomy policy (#119): the gate pricer that auto-relaxes/re-tightens #95 rules. */
  gatePricing: gatePricingSchema.optional(),
  /** Self-healing flywheel policy (#117): the failure→issue→fix loop + its bounds. */
  flywheel: flywheelSchema.optional(),
  /** Marketing department fleet policy (#123): seed-on-signup + welcome tasks (default OFF). */
  marketing: marketingSchema.optional(),
  /** Outcome Verifiers policy (#106): the measured-gate runner + escalation (default OFF). */
  verifiers: verifiersSchema.optional(),
  /** Growth-loop policy (#102): distribution instrumentation + funnel scoring (default OFF). */
  growth: growthSchema.optional(),
  /** Insight Miner policy (#100): the evidence-mining loop feeding the #96 SOURCE stage (default OFF). */
  insight: insightSchema.optional(),
  /** Moat-accrual policy (#103): moat scoring weights + stagnation-flagging window (default OFF). */
  moat: moatSchema.optional(),
  /** Customer Voice Loop policy (#114): post-launch support/feedback/churn loop (default OFF). */
  voice: voiceSchema.optional(),
  /** Portfolio Lifecycle Loop policy (#107): launched-venture review thresholds + weights (default OFF). */
  portfolio: portfolioSchema.optional(),
  /** Product Planning Loop policy (#115): RICE backlog → specs → proposed sessions (default OFF). */
  planning: planningSchema.optional(),
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
export type ScaleConfig = z.infer<typeof scaleSchema>;
export type BillingConfig = z.infer<typeof billingSchema>;
export type VentureConfig = z.infer<typeof ventureSchema>;
export type WatchdogConfig = z.infer<typeof watchdogSchema>;
export type SreConfig = z.infer<typeof sreSchema>;
export type SreServiceConfig = z.infer<typeof sreServiceSchema>;
export type ReliabilityConfig = z.infer<typeof reliabilitySchema>;
export type GatePricingConfig = z.infer<typeof gatePricingSchema>;
export type FlywheelConfig = z.infer<typeof flywheelSchema>;
export type MarketingConfig = z.infer<typeof marketingSchema>;
export type VerifierConfig = z.infer<typeof verifiersSchema>;
export type GrowthConfig = z.infer<typeof growthSchema>;
export type InsightConfig = z.infer<typeof insightSchema>;
export type MoatConfig = z.infer<typeof moatSchema>;
export type VoiceConfig = z.infer<typeof voiceSchema>;
export type PortfolioConfig = z.infer<typeof portfolioSchema>;
export type PlanningConfig = z.infer<typeof planningSchema>;
export type CredentialScopesConfig = z.infer<typeof credentialScopesSchema>;
export type EgressConfig = z.infer<typeof egressSchema>;
export type RbacConfig = z.infer<typeof rbacSchema>;
export type AutomationsConfig = z.infer<typeof automationsSchema>;
export type ConstitutionConfig = z.infer<typeof constitutionSchema>;
export type FleetConfig = z.infer<typeof fleetSchema>;
export type CatalogConfig = z.infer<typeof catalogSchema>;
export type WorkflowsConfig = z.infer<typeof workflowsSchema>;
export type BuildLoopConfig = z.infer<typeof buildLoopSchema>;

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
  /** Reliability surface policy (#148). A partial whose hard defaults `resolveReliabilityCaps` fills. */
  reliability: ReliabilityConfig;
  /** Evidence-Priced Autonomy policy (#119). A partial whose hard defaults `resolveGatePricingCaps` fills. */
  gatePricing: GatePricingConfig;
  /** Self-healing flywheel policy (#117). A partial whose hard defaults `resolveFlywheelCaps` fills. */
  flywheel: FlywheelConfig;
  /** Marketing department fleet policy (#123). A partial whose hard defaults `resolveMarketingCaps` fills. */
  marketing: MarketingConfig;
  /** Outcome Verifiers policy (#106). A partial whose hard defaults `resolveVerifierCaps` fills. */
  verifiers: VerifierConfig;
  /** Growth-loop policy (#102). A partial whose hard defaults `resolveGrowthCaps` fills. */
  growth: GrowthConfig;
  /** Insight Miner policy (#100). A partial whose hard defaults `resolveInsightCaps` fills. */
  insight: InsightConfig;
  /** Moat-accrual policy (#103). A partial whose hard defaults `resolveMoatCaps` fills. */
  moat: MoatConfig;
  /** Customer Voice Loop policy (#114). A partial whose hard defaults `resolveVoiceCaps` fills. */
  voice: VoiceConfig;
  /** Portfolio Lifecycle Loop policy (#107). A partial whose hard defaults `resolvePortfolioCaps` fills. */
  portfolio: PortfolioConfig;
  /** Product Planning Loop policy (#115). A partial whose hard defaults `resolvePlanningCaps` fills. */
  planning: PlanningConfig;
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
  // #147: the trial free tier is the built-in baseline (default-ON), not an empty/unlimited block.
  scale: { ...TRIAL_SCALE_DEFAULTS },
  venture: {},
  watchdog: {},
  sre: {},
  reliability: {},
  gatePricing: {},
  flywheel: {},
  marketing: {},
  verifiers: {},
  growth: {},
  insight: {},
  moat: {},
  voice: {},
  portfolio: {},
  planning: {},
  credentialScopes: {},
  egress: {},
  rbac: {},
  automations: {},
  constitution: {},
  fleet: {},
  catalog: {},
  workflows: {},
  buildLoop: {},
};
