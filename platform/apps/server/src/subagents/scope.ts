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

/**
 * Map a persona + its resolved tool scope to the harness env contract. Only sets a key when it has a
 * value: an empty scope omits `AGENT_ALLOWED_TOOLS` entirely (the harness then applies no tool
 * restriction var — the persona simply has no extra allow-list to pass).
 */
export function personaHarnessEnv(
  persona: PersonaPromptConfig,
  scope: string[],
): Record<string, string> {
  const env: Record<string, string> = {
    AGENT_APPEND_SYSTEM_PROMPT: persona.systemPrompt,
  };
  if (scope.length > 0) env.AGENT_ALLOWED_TOOLS = scope.join(",");
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
