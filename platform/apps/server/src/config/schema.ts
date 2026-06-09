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
  /** Model/provider selection policy (#52): which providers/models a tenant allows + defaults. */
  models: modelsSchema.optional(),
});

/** One config layer — a validated partial. */
export type Settings = z.infer<typeof settingsSchema>;
export type SlashCommandConfig = z.infer<typeof slashCommandSchema>;
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type EffortLevel = z.infer<typeof effortLevelSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ModelsConfig = z.infer<typeof modelsSchema>;

/** The resolved, defaults-applied config consumed by the rest of the server. */
export interface ResolvedConfig {
  dataPrivacyMode: boolean;
  filesToCopy: string[];
  workspaceRoot: string;
  slashCommands: Record<string, SlashCommandConfig>;
  mcpServers: Record<string, McpServerConfig>;
  skills: string[];
  /** Model/provider selection policy (#52). A partial whose hard defaults `modelPolicyFromConfig` fills. */
  models: ModelsConfig;
}

/** Lowest layer: the built-in defaults (today's behavior — privacy off, no files, local ws root). */
export const CONFIG_DEFAULTS: ResolvedConfig = {
  dataPrivacyMode: false,
  filesToCopy: [],
  workspaceRoot: ".reload/workspaces",
  slashCommands: {},
  mcpServers: {},
  skills: [],
  models: {},
};
