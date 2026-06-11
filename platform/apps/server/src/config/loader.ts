import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { mergeLayers, mergeSettings } from "./layers.js";
import { settingsSchema, type ResolvedConfig, type Settings } from "./schema.js";

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

/** The env base layer: the lowest-precedence source (preserves the env-only status quo). */
function envLayer(env: NodeJS.ProcessEnv): Settings {
  const raw: Record<string, unknown> = {};
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
  if (mktEnabled !== undefined || mktWelcome !== undefined) {
    const marketing: Record<string, unknown> = {};
    if (mktEnabled !== undefined) marketing.enabled = mktEnabled === "true" || mktEnabled === "1";
    if (mktWelcome !== undefined) marketing.seedWelcomeTasks = mktWelcome === "true" || mktWelcome === "1";
    raw.marketing = marketing;
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
