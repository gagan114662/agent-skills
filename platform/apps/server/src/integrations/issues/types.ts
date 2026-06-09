/**
 * Issue → session integration (#57). The seam that lets an agent **start from a GitHub or Linear
 * issue/PR**: a provider fetches the issue's context (read) and can post a status comment back
 * (act); `parseIssueRef` + `buildIssueTask` are pure so they are unit-tested without network.
 *
 * Provider tokens are resolved per-tenant from the #25 `SecretsResolver` at request time and passed
 * to these methods as the `token` arg — they are NEVER read from config and NEVER logged. A provider
 * failure surfaces as a typed {@link IssueProviderError} whose message carries no token/request body.
 */
export type IssueSource = "github" | "linear";

/** A parsed issue reference. GitHub uses owner/repo/number; Linear uses team/number (`key` = full id). */
export interface IssueRef {
  source: IssueSource;
  /** GitHub repo owner. */
  owner?: string;
  /** GitHub repo name. */
  repo?: string;
  /** Issue/PR number (GitHub) or the numeric part of a Linear identifier. */
  number?: number;
  /** Linear team key, e.g. `ENG`. */
  team?: string;
  /** Linear full identifier, e.g. `ENG-123`. */
  key?: string;
  /** The original ref string (for messages/echoing). */
  raw: string;
}

/** Normalized issue context shared by every provider — what gets rendered into the agent's task. */
export interface IssueContext {
  source: IssueSource;
  /** Canonical ref string, e.g. `github:acme/web#42` or `linear:ENG-123`. */
  ref: string;
  id: string;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  author?: string;
}

/** A provider reads an issue and can act on it (comment). One adapter per {@link IssueSource}. */
export interface IssueProvider {
  readonly source: IssueSource;
  /** Read: fetch and normalize the referenced issue. Throws {@link IssueProviderError} on failure. */
  fetchIssue(ref: IssueRef, token?: string): Promise<IssueContext>;
  /** Act: post a comment back to the issue. Best-effort at the call site (never fails a launch). */
  postComment(ref: IssueRef, token: string | undefined, body: string): Promise<{ url: string }>;
}

/** Thrown when a ref string cannot be parsed into a provider + locator. */
export class IssueRefError extends Error {
  constructor(detail: string) {
    super(`invalid issue ref: ${detail}`);
    this.name = "IssueRefError";
  }
}

/** Thrown when a provider call fails. Message is deliberately content-free (no token/body). */
export class IssueProviderError extends Error {
  constructor(source: IssueSource, detail: string) {
    super(`${source}: ${detail}`);
    this.name = "IssueProviderError";
  }
}

const GITHUB_REF = /^(?:github:)?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/;
const LINEAR_REF = /^linear:([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/**
 * Parse an issue ref. Accepts:
 *   - `github:owner/repo#42` or the shorthand `owner/repo#42`  → GitHub
 *   - `linear:ENG-123`                                         → Linear
 * Anything else throws {@link IssueRefError}. Linear requires the explicit `linear:` scheme so a bare
 * `ENG-123` is never mistaken for something else.
 */
export function parseIssueRef(raw: string): IssueRef {
  const value = raw.trim();
  if (!value) throw new IssueRefError("empty");

  const linear = LINEAR_REF.exec(value);
  if (linear) {
    const [, team, num] = linear;
    return { source: "linear", team, number: Number(num), key: `${team}-${num}`, raw: value };
  }

  const gh = GITHUB_REF.exec(value);
  if (gh) {
    const [, owner, repo, num] = gh;
    return { source: "github", owner, repo, number: Number(num), raw: value };
  }

  throw new IssueRefError(`unrecognized ref "${value}" (expected owner/repo#N or linear:KEY-N)`);
}

/** Canonical string form of a ref (stable for echoing in responses/messages). */
export function formatIssueRef(ref: IssueRef): string {
  return ref.source === "github"
    ? `github:${ref.owner}/${ref.repo}#${ref.number}`
    : `linear:${ref.key}`;
}

const BODY_MAX = 4000;

/**
 * Render an {@link IssueContext} into the agent's task prompt. The result is injected as the
 * `AGENT_TASK` env **data** of the #50 harness contract — never interpolated into argv — so even
 * hostile issue text cannot reach a shell. The body is truncated deterministically.
 */
export function buildIssueTask(ctx: IssueContext, instructions?: string): string {
  const body =
    ctx.body.length > BODY_MAX ? `${ctx.body.slice(0, BODY_MAX)}\n…[truncated]` : ctx.body;
  const labels = ctx.labels.length ? ctx.labels.join(", ") : "(none)";
  const lines = [
    `You are working on a ${ctx.source} issue. Read the context, then make the change it asks for.`,
    "",
    `Title: ${ctx.title}`,
    `URL: ${ctx.url}`,
    `State: ${ctx.state}`,
    `Labels: ${labels}`,
    "",
    "--- Issue description ---",
    body || "(no description)",
  ];
  if (instructions && instructions.trim()) {
    lines.push("", "--- Additional instructions ---", instructions.trim());
  }
  return lines.join("\n");
}
