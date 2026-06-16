import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { mergeLayers, mergeSettings } from "./layers.js";
import {
  settingsSchema,
  TRIAL_SCALE_DEFAULTS,
  type ResolvedConfig,
  type ScaleConfig,
  type Settings,
} from "./schema.js";

export { mergeLayers, mergeSettings };
export { CONFIG_DEFAULTS } from "./schema.js";
export type { ResolvedConfig, Settings } from "./schema.js";

/**
 * Layered config loader (#58, ADR-0035). Precedence is **env < user < repo < managed** — env is the
 * base (today's behavior), file layers refine it, and the managed/enterprise layer is applied last
 * so it cannot be overridden. The managed layer may carry **per-tenant** overrides keyed by
 * workspace id.
 *
 * Resolution is hermetic and injectable: file reads and paths can be supplied so unit tests never
 * touch real disk. A **missing** file is simply an absent layer; a **malformed** file degrades to an
 * absent layer (it never crashes boot or leaks file contents in an error); a **schema-invalid** file
 * (well-formed TOML, wrong types) throws a clear, content-free {@link ConfigValidationError}.
 */
export interface ConfigSources {
  /** Env source for the base layer + path overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable reader: returns file contents, or `undefined` if the file is absent. */
  readFile?: (path: string) => string | undefined;
  /** Override the user-scope settings path (default `~/.reload/settings.toml`). */
  userPath?: string;
  /** Override the repo-scope settings path (default `<cwd>/.reload/settings.toml`). */
  repoPath?: string;
  /** Override the managed-scope settings path (default `/etc/reload/managed.toml`). */
  managedPath?: string;
}

/** Thrown when a well-formed config layer fails schema validation. Carries no file content. */
export class ConfigValidationError extends Error {
  constructor(layer: string, detail: string) {
    super(`invalid config in ${layer} layer: ${detail}`);
    this.name = "ConfigValidationError";
  }
}

/** Default disk reader: an absent/unreadable file is an absent layer, never an error. */
function readFromDisk(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Validate a raw object as one layer; throws a content-free error listing offending field paths. */
function parseLayer(raw: unknown, layer: string): Settings {
  const result = settingsSchema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  throw new ConfigValidationError(layer, detail);
}

/** A flat TOML settings file (user/repo scope). Malformed → absent layer; invalid types → throw. */
function readSettingsFile(
  path: string,
  read: (p: string) => string | undefined,
  layer: string,
): Settings {
  const raw = read(path);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    return {}; // malformed syntax degrades to an absent layer (resilience + no content leak)
  }
  return parseLayer(parsed, layer);
}

/** Parse a `RELOAD_FILES_TO_COPY` value: a JSON array or a comma-separated list. */
function parseFileList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      /* fall through to CSV */
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a non-negative integer env value, falling back to `fallback` on absent/garbage (never throws). */
function envInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the trial free-tier scale block from the env base layer (#147, ADR-0147). **Default-ON**: an
 * absent `RELOAD_TRIAL_ENABLED` yields the usable free tier ({@link TRIAL_SCALE_DEFAULTS}) so a fresh
 * workspace can run agents before checkout→caps is wired. `RELOAD_TRIAL_ENABLED=false`/`0` returns an
 * **empty** block (present, so it overrides the baseline → 0 caps = today's unlimited behavior).
 * `RELOAD_TRIAL_TENANT_CONCURRENCY` / `RELOAD_TRIAL_BUDGET_CENTS` tune the tier. This is the LOWEST
 * layer, so any higher `[scale]` (a paid plan's per-tenant managed override) fully replaces it.
 */
function trialScale(env: NodeJS.ProcessEnv): ScaleConfig {
  const enabled = env.RELOAD_TRIAL_ENABLED !== "false" && env.RELOAD_TRIAL_ENABLED !== "0";
  if (!enabled) return {};
  return {
    tenantConcurrency: envInt(env.RELOAD_TRIAL_TENANT_CONCURRENCY, TRIAL_SCALE_DEFAULTS.tenantConcurrency),
    budgetCents: envInt(env.RELOAD_TRIAL_BUDGET_CENTS, TRIAL_SCALE_DEFAULTS.budgetCents),
  };
}

/** The env base layer: the lowest-precedence source (preserves the env-only status quo). */
function envLayer(env: NodeJS.ProcessEnv): Settings {
  const raw: Record<string, unknown> = {};
  // #147 trial free tier: ON by default in the env base layer (the one non-opt-in block). A higher
  // layer that sets [scale] (a paid plan's managed override) replaces it wholesale.
  raw.scale = trialScale(env);
  const privacy = env.RELOAD_DATA_PRIVACY_MODE;
  if (privacy !== undefined) raw.dataPrivacyMode = privacy === "true" || privacy === "1";
  const files = env.RELOAD_FILES_TO_COPY;
  if (files !== undefined) raw.filesToCopy = parseFileList(files);
  const root = env.RELOAD_WORKSPACE_ROOT;
  if (root !== undefined) raw.workspaceRoot = root;
  // #138 marketing department fleet: let the deployment env turn the agency on (ipop.ai's fly.toml sets
  // these) without baking a managed.toml into the image. Hard default stays OFF (env vars unset → no
  // marketing block); a managed layer still wins as the lock. seedWelcomeTasks stays false in prod so
  // the seed/backfill never launches (spends on) welcome sessions.
  const mktEnabled = env.RELOAD_MARKETING_ENABLED;
  const mktWelcome = env.RELOAD_MARKETING_SEED_WELCOME_TASKS;
  // #258: designate ipop.ai's OWN workspace from the deployment env (no managed.toml needed) so the
  // internal-only connectors (the GitHub site-publish paste) are admin-gated to exactly that workspace.
  const mktOwner = env.RELOAD_MARKETING_OWNER_WORKSPACE_ID;
  if (mktEnabled !== undefined || mktWelcome !== undefined || mktOwner) {
    const marketing: Record<string, unknown> = {};
    if (mktEnabled !== undefined) marketing.enabled = mktEnabled === "true" || mktEnabled === "1";
    if (mktWelcome !== undefined) marketing.seedWelcomeTasks = mktWelcome === "true" || mktWelcome === "1";
    if (mktOwner) marketing.ownerWorkspaceId = mktOwner;
    raw.marketing = marketing;
  }
  // #151 governance: let the deployment env turn workspace-role enforcement + the egress allowlist on
  // without baking a managed.toml. Hard default stays OFF (vars unset → no block); a managed layer still
  // wins as the lock. The per-agent credential matrix is config-file only (it is a nested map).
  const rbacEnabled = env.RELOAD_RBAC_ENABLED;
  if (rbacEnabled !== undefined) raw.rbac = { enabled: rbacEnabled === "true" || rbacEnabled === "1" };
  const egressEnabled = env.RELOAD_EGRESS_ENABLED;
  const egressAllowlist = env.RELOAD_EGRESS_ALLOWLIST;
  if (egressEnabled !== undefined || egressAllowlist !== undefined) {
    const egress: Record<string, unknown> = {};
    if (egressEnabled !== undefined) egress.enabled = egressEnabled === "true" || egressEnabled === "1";
    if (egressAllowlist !== undefined) {
      egress.allowlist = egressAllowlist
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    raw.egress = egress;
  }
  // #152 catalog + workflows: let the deployment env turn the marketing-asset registry + the workflow
  // builder on without baking a managed.toml. Hard default stays OFF (vars unset → no block); a managed
  // layer still wins as the lock. The firing timer is separate (WORKFLOWS_INTERVAL_MS).
  const catalogEnabled = env.RELOAD_CATALOG_ENABLED;
  if (catalogEnabled !== undefined) raw.catalog = { enabled: catalogEnabled === "true" || catalogEnabled === "1" };
  const workflowsEnabled = env.RELOAD_WORKFLOWS_ENABLED;
  if (workflowsEnabled !== undefined) {
    raw.workflows = { enabled: workflowsEnabled === "true" || workflowsEnabled === "1" };
  }
  // #170 slack-native: let the deployment env turn the proactive digest tick on without baking a
  // managed.toml. Hard default stays OFF (vars unset → no block); a managed layer still wins as the
  // lock. The bot token + signing secret are NEVER env/config — they live in the #68 sealed vault.
  const slackEnabled = env.RELOAD_SLACK_ENABLED;
  const slackDigest = env.RELOAD_SLACK_DIGEST_ENABLED;
  if (slackEnabled !== undefined || slackDigest !== undefined) {
    const slack: Record<string, unknown> = {};
    if (slackEnabled !== undefined) slack.enabled = slackEnabled === "true" || slackEnabled === "1";
    if (slackDigest !== undefined) slack.digestEnabled = slackDigest === "true" || slackDigest === "1";
    raw.slack = slack;
  }
  // #173 founder briefings: let the deployment env opt the reporting layer in without a managed.toml.
  // Hard default stays OFF (var unset → no block); a managed layer still wins as the lock. The delivery
  // timer is separate (BRIEFINGS_INTERVAL_MS).
  const briefingsEnabled = env.RELOAD_BRIEFINGS_ENABLED;
  if (briefingsEnabled !== undefined) {
    raw.briefings = { enabled: briefingsEnabled === "true" || briefingsEnabled === "1" };
  }
  // #192 external account onboarding: let the deployment env opt a workspace in without a managed.toml —
  // the owner workspace flips this first. Hard default stays OFF (var unset → no block ⇒ no credential
  // injection + the connect/DNS writes 409). A managed layer still wins as the lock. Per-service keys are
  // NEVER env/config — they live in the #192 sealed vault.
  const onboardingEnabled = env.RELOAD_ONBOARDING_ENABLED;
  if (onboardingEnabled !== undefined) {
    raw.onboarding = { enabled: onboardingEnabled === "true" || onboardingEnabled === "1" };
  }
  // #231 real-world tool surface: let the deployment env turn the surface on + pick a live publish
  // provider without a managed.toml — the owner workspace opts in first. Hard default stays OFF (vars
  // unset → no block ⇒ publish stays `dryrun`, a non-reachable URL, no network). A managed layer still
  // wins as the lock. The GitHub token is NEVER config — it's read from the secret env at publish time.
  const realworldEnabled = env.RELOAD_REALWORLD_ENABLED;
  const realworldProvider = env.RELOAD_REALWORLD_PUBLISH_PROVIDER;
  // #250 self-publish to ipop.ai: the site-PR provider + repo come from env too (token stays secret env).
  const sitePrProvider = env.RELOAD_REALWORLD_SITE_PR_PROVIDER;
  const siteRepo = env.RELOAD_REALWORLD_SITE_REPO;
  const siteBaseBranch = env.RELOAD_REALWORLD_SITE_BASE_BRANCH;
  const siteContentDir = env.RELOAD_REALWORLD_SITE_CONTENT_DIR;
  if (
    realworldEnabled !== undefined ||
    realworldProvider !== undefined ||
    sitePrProvider !== undefined ||
    siteRepo !== undefined ||
    siteBaseBranch !== undefined ||
    siteContentDir !== undefined
  ) {
    raw.realworld = {
      ...(realworldEnabled !== undefined
        ? { enabled: realworldEnabled === "true" || realworldEnabled === "1" }
        : {}),
      ...(realworldProvider !== undefined ? { publishProvider: realworldProvider } : {}),
      ...(sitePrProvider !== undefined ? { sitePrProvider } : {}),
      ...(siteRepo !== undefined ? { siteRepo } : {}),
      ...(siteBaseBranch !== undefined ? { siteBaseBranch } : {}),
      ...(siteContentDir !== undefined ? { siteContentDir } : {}),
    };
  }
  // #225 outreach engine: let the deployment env turn the proactive posture on + pick a sender without a
  // managed.toml — the owner workspace opts in first. Hard default stays OFF (vars unset → no block ⇒ the
  // sender stays `dryrun`, recorded-only, no network egress). A managed layer still wins as the lock.
  const outreachEnabled = env.RELOAD_OUTREACH_ENABLED;
  const outreachProvider = env.RELOAD_OUTREACH_SEND_PROVIDER;
  const outreachCap = env.RELOAD_OUTREACH_PER_CHANNEL_DAILY_CAP;
  if (outreachEnabled !== undefined || outreachProvider !== undefined || outreachCap !== undefined) {
    const cap = outreachCap !== undefined ? Number.parseInt(outreachCap, 10) : undefined;
    raw.outreach = {
      ...(outreachEnabled !== undefined
        ? { enabled: outreachEnabled === "true" || outreachEnabled === "1" }
        : {}),
      ...(outreachProvider !== undefined ? { sendProvider: outreachProvider } : {}),
      ...(cap !== undefined && Number.isFinite(cap) && cap > 0 ? { perChannelDailyCap: cap } : {}),
    };
  }
  // #189 acquisition execution: let the deployment env turn the real-send dispatcher + per-channel
  // execution on without a managed.toml — the owner workspace opts in first. Hard default stays OFF
  // (vars unset → no block ⇒ the `external.send` executor stays recorded-only, no network egress). A
  // managed layer still wins as the lock. Per-channel real sends ALSO require the owner to connect the
  // provider in the #192 vault — the flag alone never sends. `autoSend` (no-human send) stays its own
  // stricter switch, separately OFF.
  const acqEnabled = env.RELOAD_ACQUISITION_ENABLED;
  const acqChannels = {
    ads: env.RELOAD_ACQUISITION_ADS,
    email: env.RELOAD_ACQUISITION_EMAIL,
    social: env.RELOAD_ACQUISITION_SOCIAL,
    seo: env.RELOAD_ACQUISITION_SEO,
    autoSend: env.RELOAD_ACQUISITION_AUTO_SEND,
  };
  if (acqEnabled !== undefined || Object.values(acqChannels).some((v) => v !== undefined)) {
    const acquisition: Record<string, unknown> = {};
    const flag = (v: string | undefined) => v === "true" || v === "1";
    if (acqEnabled !== undefined) acquisition.enabled = flag(acqEnabled);
    if (acqChannels.ads !== undefined) acquisition.ads = flag(acqChannels.ads);
    if (acqChannels.email !== undefined) acquisition.email = flag(acqChannels.email);
    if (acqChannels.social !== undefined) acquisition.social = flag(acqChannels.social);
    if (acqChannels.seo !== undefined) acquisition.seo = flag(acqChannels.seo);
    if (acqChannels.autoSend !== undefined) acquisition.autoSend = flag(acqChannels.autoSend);
    raw.acquisition = acquisition;
  }
  // #222 customer discovery engine: let the deployment env turn the proactive posture on without a
  // managed.toml (the owner workspace opts in first). Hard default stays OFF (var unset → no block);
  // ingest/queue/PQL/growth-emission are always live regardless — a workspace that ingests no signals
  // stays byte-for-byte unchanged. This issue is READ-ONLY (never sends).
  const discoveryEnabled = env.RELOAD_DISCOVERY_ENABLED;
  if (discoveryEnabled !== undefined) {
    raw.discovery = { enabled: discoveryEnabled === "true" || discoveryEnabled === "1" };
  }
  // #282 agent registry + A2A: let the deployment env turn the department-fleet A2A surface on without a
  // managed.toml (the owner workspace opts in first). Hard default stays OFF (var unset → no block); the
  // contract catalog is always readable regardless. A managed layer still wins as the lock.
  const agentRegistryEnabled = env.RELOAD_AGENT_REGISTRY_ENABLED;
  const agentRegistryOwner = env.RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID;
  if (agentRegistryEnabled !== undefined || agentRegistryOwner) {
    const agentRegistry: Record<string, unknown> = {};
    if (agentRegistryEnabled !== undefined) {
      agentRegistry.enabled = agentRegistryEnabled === "true" || agentRegistryEnabled === "1";
    }
    if (agentRegistryOwner) agentRegistry.ownerWorkspaceId = agentRegistryOwner;
    raw.agentRegistry = agentRegistry;
  }
  // #294 SEO rank tracking: let the deployment env turn the proactive rank FETCH on + pick a provider +
  // owner workspace without a managed.toml (owner workspace opts in first). Hard default stays OFF (vars
  // unset → no block ⇒ provider stays `dryrun`, reports nothing). Recording an external receipt is always
  // allowed regardless of this flag. A managed layer still wins as the lock.
  const seoEnabled = env.RELOAD_SEO_ENABLED;
  const seoProvider = env.RELOAD_SEO_PROVIDER;
  const seoOwner = env.RELOAD_SEO_OWNER_WORKSPACE_ID;
  if (seoEnabled !== undefined || seoProvider !== undefined || seoOwner) {
    const seo: Record<string, unknown> = {};
    if (seoEnabled !== undefined) seo.enabled = seoEnabled === "true" || seoEnabled === "1";
    if (seoProvider !== undefined) seo.provider = seoProvider;
    if (seoOwner) seo.ownerWorkspaceId = seoOwner;
    raw.seo = seo;
  }
  // #194 finance ledger: let the deployment env opt the accounting layer in without a managed.toml.
  // Hard default stays OFF (var unset → no block); a managed layer still wins as the lock. The posting/
  // close timer is separate (FINANCE_INTERVAL_MS).
  const financeEnabled = env.RELOAD_FINANCE_ENABLED;
  if (financeEnabled !== undefined) {
    raw.finance = { enabled: financeEnabled === "true" || financeEnabled === "1" };
  }
  // #195 venture deploys: let the deployment env opt the per-venture provisioning + release pipeline in
  // without a managed.toml (the owner workspace opts in first). Hard default stays OFF (var unset → no
  // block); a managed layer still wins as the lock. The infra backend is selectable via env too.
  const ventureDeploysEnabled = env.RELOAD_VENTURE_DEPLOYS_ENABLED;
  if (ventureDeploysEnabled !== undefined) {
    const ventureDeploys: Record<string, unknown> = {
      enabled: ventureDeploysEnabled === "true" || ventureDeploysEnabled === "1",
    };
    const provider = env.VENTURE_DEPLOY_PROVIDER;
    if (provider === "dryrun" || provider === "fly" || provider === "vercel") {
      ventureDeploys.provider = provider;
    }
    raw.ventureDeploys = ventureDeploys;
  }
  // #98 billing opt-in: present the `[billing]` config section (the per-tenant checkout gate) from the
  // deployment env — mirroring marketing/rbac/catalog — so live billing can be switched on without
  // baking a managed.toml. The provider VALUE mirrors the env-level `BILLING_PROVIDER` (the actual
  // backend selection); this only flips the opt-in gate that routes checkout to 409 when absent. Hard
  // default stays OFF (var unset → no billing block → 409). A managed layer still wins as the lock and
  // can scope billing to specific `[workspace.<id>]` tenants.
  const billingEnabled = env.RELOAD_BILLING_ENABLED;
  if (billingEnabled === "true" || billingEnabled === "1") {
    raw.billing = { provider: env.BILLING_PROVIDER === "stripe" ? "stripe" : "none" };
  }
  // #174 agent browser runtime: let the deployment env give agents a real browser without baking a
  // managed.toml (the owner workspace opts in first). Hard default stays OFF (var unset → no block);
  // a managed layer still wins as the lock. The per-session caps + domain allow/denylist are tunable
  // via env too. Chromium/Playwright is NEVER a secret — the binary lives in the runtime image.
  const browserEnabled = env.RELOAD_AGENT_BROWSER_ENABLED;
  const browserAllowlist = env.RELOAD_AGENT_BROWSER_ALLOWLIST;
  const browserDenylist = env.RELOAD_AGENT_BROWSER_DENYLIST;
  const browserMaxPages = env.RELOAD_AGENT_BROWSER_MAX_PAGES;
  const browserMaxSeconds = env.RELOAD_AGENT_BROWSER_MAX_WALLCLOCK_SECONDS;
  const browserMaxBytes = env.RELOAD_AGENT_BROWSER_MAX_BANDWIDTH_BYTES;
  if (
    browserEnabled !== undefined ||
    browserAllowlist !== undefined ||
    browserDenylist !== undefined ||
    browserMaxPages !== undefined ||
    browserMaxSeconds !== undefined ||
    browserMaxBytes !== undefined
  ) {
    const browser: Record<string, unknown> = {};
    if (browserEnabled !== undefined) browser.enabled = browserEnabled === "true" || browserEnabled === "1";
    if (browserAllowlist !== undefined) browser.allowlist = parseFileList(browserAllowlist);
    if (browserDenylist !== undefined) browser.denylist = parseFileList(browserDenylist);
    if (browserMaxPages !== undefined) browser.maxPages = envInt(browserMaxPages, 0);
    if (browserMaxSeconds !== undefined) browser.maxWallClockSeconds = envInt(browserMaxSeconds, 0);
    if (browserMaxBytes !== undefined) browser.maxBandwidthBytes = envInt(browserMaxBytes, 0);
    raw.browser = browser;
  }
  return parseLayer(raw, "env");
}

/** The managed/enterprise layer: global `[settings]` plus an optional per-tenant `[workspace.<id>]`. */
function managedLayer(
  path: string,
  read: (p: string) => string | undefined,
  workspaceId: string | undefined,
): Settings {
  const rawText = read(path);
  if (rawText === undefined) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(rawText) as Record<string, unknown>;
  } catch {
    return {};
  }
  const global = parseLayer(parsed.settings ?? {}, "managed.settings");
  let perTenant: Settings = {};
  if (workspaceId) {
    const table = parsed.workspace as Record<string, unknown> | undefined;
    const tenant = table?.[workspaceId];
    if (tenant !== undefined) perTenant = parseLayer(tenant, `managed.workspace.${workspaceId}`);
  }
  // Per-tenant managed beats managed-global; the result is one partial that is the top layer.
  return mergeSettings([global, perTenant]);
}

/** Default managed-config path. A system/enterprise location; overridable via `RELOAD_MANAGED_CONFIG`. */
function defaultManagedPath(): string {
  return join("/etc", "reload", "managed.toml");
}

/**
 * Resolve the layered config for a tenant. Pass the `workspaceId` to apply that tenant's managed
 * overrides; omit it for the server-level config (managed-global only) — used for deployment-wide
 * egress decisions.
 */
export function loadConfig(workspaceId?: string, sources: ConfigSources = {}): ResolvedConfig {
  const env = sources.env ?? process.env;
  const read = sources.readFile ?? readFromDisk;
  const userPath =
    sources.userPath ?? env.RELOAD_USER_CONFIG ?? join(homedir(), ".reload", "settings.toml");
  const repoPath =
    sources.repoPath ?? env.RELOAD_REPO_CONFIG ?? join(process.cwd(), ".reload", "settings.toml");
  const managedPath = sources.managedPath ?? env.RELOAD_MANAGED_CONFIG ?? defaultManagedPath();

  // Low → high precedence: env < user < repo < managed.
  return mergeLayers([
    envLayer(env),
    readSettingsFile(userPath, read, "user"),
    readSettingsFile(repoPath, read, "repo"),
    managedLayer(managedPath, read, workspaceId),
  ]);
}
