/**
 * Subagent persona scope — pure logic (#59).
 *
 * The security heart of custom subagents: a persona declares a **tool ceiling** (`allowedTools`) and
 * a persona prompt. This module resolves the effective tool set for an invocation (narrow-only — an
 * invoker can never widen the ceiling) and maps a persona to the harness env contract. Everything
 * here is pure and I/O-free so the non-escalation guarantees are unit-tested without a DB or a
 * running harness.
 *
 * Persona config reaches the harness ONLY via environment variables (the same contract as
 * `AGENT_TASK`, #50): `AGENT_APPEND_SYSTEM_PROMPT` and `AGENT_ALLOWED_TOOLS`. It is never
 * interpolated into argv, so a hostile persona prompt cannot inject shell.
 */

/** A valid #6 mention token / Claude Code tool name charset. */
const HANDLE_RE = /^[A-Za-z0-9._-]+$/;
const TOOL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * The read-only WEB tool surface (#250). These are Claude Code's OWN built-in tools, so they are
 * exposed to a session purely by appearing in the `--allowedTools` list the harness builds — nothing
 * else to wire. They are DATA-only (a fetch / a search returns text, never an actuator), so — exactly
 * like the #223 read surface — they are always safe to grant and are NEVER gated. {@link
 * personaHarnessEnv} unions them into EVERY scoped persona's allowlist so a task that needs the live web
 * (an SEO audit, competitor research) can never silently fail just because a persona's declared tool
 * ceiling omitted them. An unscoped session already inherits all of Claude Code's built-ins (these
 * included), so this only ever ADDS capability — it can never remove a tool a session had before.
 */
export const WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

export class PersonaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaValidationError";
  }
}

/**
 * Resolve the effective tool set for an invocation. The persona's `allowedTools` is the ceiling;
 * when `requested` is provided the result is the **intersection** (the invoker may narrow), otherwise
 * it is the ceiling itself. The result is ALWAYS a subset of `personaTools` — there is no path by
 * which a request widens the ceiling. De-duped, order follows the ceiling.
 */
export function resolveToolScope(personaTools: string[], requested?: string[]): string[] {
  const ceiling = dedupe(personaTools);
  if (!requested) return ceiling;
  const want = new Set(requested);
  return ceiling.filter((tool) => want.has(tool));
}

export interface PersonaPromptConfig {
  systemPrompt: string;
  model: string | null;
}

/** A valid skill id charset (e.g. `lens/runbook`) — mention-safe + shell-safe, like a tool name. */
const SKILL_ID_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Map a persona + its resolved tool scope (+ its skill kit) to the harness env contract. Only sets a key
 * when it has a value: an empty scope omits `AGENT_ALLOWED_TOOLS` and an empty skill list omits
 * `AGENT_SKILLS`, so a non-persona / skill-less session's behavior is unchanged.
 *
 * `AGENT_SKILLS` (#155) carries the comma-joined skill ids this session loads — the same env-not-argv
 * contract as the prompt/tools/model. The runtime (#68) reads it to load the agent's versioned knowledge +
 * runbook skills per session; skill ids are charset-validated so a hostile id can never inject shell.
 */
export function personaHarnessEnv(
  persona: PersonaPromptConfig,
  scope: string[],
  skills: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_APPEND_SYSTEM_PROMPT: persona.systemPrompt,
  };
  // #250: a scoped session always gets the read-only web tools, even if the persona ceiling omitted
  // them — so web-dependent work (SEO audits, research) never fails for lack of a fetch tool. We only
  // add them when the session is already scoped (a non-empty ceiling sets `--allowedTools`); an empty
  // scope is left untouched so an unscoped session keeps ALL of Claude Code's built-ins (web included)
  // rather than being narrowed down to just two tools.
  if (scope.length > 0) env.AGENT_ALLOWED_TOOLS = dedupe([...scope, ...WEB_TOOLS]).join(",");
  const safeSkills = dedupe(skills.map((s) => s.trim())).filter((s) => s && SKILL_ID_RE.test(s));
  if (safeSkills.length > 0) env.AGENT_SKILLS = safeSkills.join(",");
  return env;
}

export interface PersonaInput {
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  model?: string | null;
}

export interface ValidatedPersonaInput {
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string | null;
}

/**
 * Validate + normalize a persona definition. Bounds it to non-secret, mention-safe, shell-safe
 * values: a handle that is a valid mention token, a non-empty prompt, and tool names restricted to a
 * safe charset (defense in depth — the prompt/tools also only ever reach the harness via env).
 * Throws {@link PersonaValidationError} with a clear, content-free message on the first violation.
 */
export function validatePersonaInput(input: PersonaInput): ValidatedPersonaInput {
  const name = (input.name ?? "").trim();
  if (!HANDLE_RE.test(name)) {
    throw new PersonaValidationError("name must match /^[A-Za-z0-9._-]+$/ (a valid @mention handle)");
  }
  const systemPrompt = (input.systemPrompt ?? "").trim();
  if (!systemPrompt) {
    throw new PersonaValidationError("systemPrompt is required");
  }
  if (!Array.isArray(input.allowedTools)) {
    throw new PersonaValidationError("allowedTools must be an array of tool names");
  }
  const allowedTools = dedupe(input.allowedTools.map((t) => (typeof t === "string" ? t.trim() : t)));
  for (const tool of allowedTools) {
    if (typeof tool !== "string" || !TOOL_RE.test(tool)) {
      throw new PersonaValidationError(`invalid tool name (must match /^[A-Za-z0-9_-]+$/)`);
    }
  }
  const model = input.model != null && String(input.model).trim() ? String(input.model).trim() : null;
  return { name, systemPrompt, allowedTools, model };
}

/** De-dupe while preserving first-appearance order. */
function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
