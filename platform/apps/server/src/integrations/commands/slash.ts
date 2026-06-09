import type { SlashCommandConfig } from "../../config/schema.js";

/**
 * Project slash commands (#57). A `/`-command is a **named prompt template** declared in the layered
 * config (`[slashCommands.<name>]`). The template is **trusted config**; the caller's args are
 * **data** substituted into the prompt text (never into argv), so the #50 `$AGENT_TASK` injection-safe
 * contract is preserved end-to-end.
 */
export interface SlashCommand {
  name: string;
  description?: string;
  prompt: string;
}

/** Thrown when a `/`-command name is not declared in the tenant's config. */
export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`unknown slash command: /${name}`);
    this.name = "UnknownCommandError";
  }
}

/** Thrown when the input does not contain a command name. */
export class SlashParseError extends Error {
  constructor(detail: string) {
    super(`invalid slash command: ${detail}`);
    this.name = "SlashParseError";
  }
}

const ARGS_PLACEHOLDER = /\{\{\s*args\s*\}\}/g;

/**
 * Parse `"/review the auth diff"` → `{ name: "review", args: "the auth diff" }`. The leading slash is
 * optional and surrounding whitespace is tolerated; an input with no name throws {@link SlashParseError}.
 */
export function parseSlashInput(input: string): { name: string; args: string } {
  const trimmed = input.trim().replace(/^\//, "");
  if (!trimmed) throw new SlashParseError("empty command");
  const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) throw new SlashParseError("empty command");
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Expand a command's template with the caller's args. If the template contains `{{args}}`, every
 * occurrence is replaced; otherwise non-empty args are appended on a new paragraph. The result is the
 * task prompt handed to the session.
 */
export function expandCommand(cmd: SlashCommand, args: string): string {
  if (ARGS_PLACEHOLDER.test(cmd.prompt)) {
    return cmd.prompt.replace(ARGS_PLACEHOLDER, args);
  }
  return args ? `${cmd.prompt}\n\n${args}` : cmd.prompt;
}

/** Resolves project slash commands from the tenant's resolved config. */
export class SlashCommandRegistry {
  private readonly commands: Map<string, SlashCommand>;

  constructor(config: Record<string, SlashCommandConfig>) {
    this.commands = new Map(
      Object.entries(config).map(([name, c]) => [
        name.toLowerCase(),
        { name: name.toLowerCase(), description: c.description, prompt: c.prompt },
      ]),
    );
  }

  /** Get a command by name; throws {@link UnknownCommandError} if it is not declared. */
  get(name: string): SlashCommand {
    const cmd = this.commands.get(name.toLowerCase());
    if (!cmd) throw new UnknownCommandError(name);
    return cmd;
  }

  /** All declared commands (for `/me/agent-config` and the Codex/Claude exporters). */
  list(): SlashCommand[] {
    return [...this.commands.values()];
  }
}
