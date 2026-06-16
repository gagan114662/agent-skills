/**
 * The self-publish-to-ipop.ai provider seam (#250) — the actuator behind the `publish_site` tool.
 *
 * Unlike {@link file://./provider.ts PublishProvider} (HTML string → a brand-new GitHub Pages site), this
 * commits a content FILE (a blog post / page) into ipop's OWN site repo on a fresh branch and opens a
 * pull request against it — so new content can be reviewed and deployed to ipop.ai through ipop's normal
 * site pipeline. ipop owns the repo, so auth is a server token (no third-party OAuth). Opening a PR is
 * reversible + money-free, so it is AUTONOMOUS (no #13 gate); merging/deploying stays a human action.
 *
 * Dry-run by default (no network — returns a deterministic fake PR url). The real {@link
 * GitHubSitePrProvider} is opted in via config `realworld.sitePrProvider = "github"` + a token.
 */

export interface SitePrInput {
  /** Tenant the content belongs to (audit/scoping). */
  workspaceId: string;
  /** Optional venture the content is for (soft-linked in the receipt). */
  ventureId?: string | null;
  /** Repo-relative path of the new content file, e.g. `content/blog/my-post.md`. */
  path: string;
  /** The file content (markdown / HTML / text) — UTF-8. */
  content: string;
  /** Pull-request title. */
  title: string;
  /** Pull-request body / description. */
  body: string;
  /** Branch to create off the base branch and open the PR from. */
  branch: string;
  /** Progress log sink (redacted by the caller). */
  onLog: (line: string) => void;
}

export interface SitePrOutcome {
  status: "ready" | "error";
  /** The pull-request URL when `status === "ready"`. */
  prUrl?: string;
  /** The head branch the content was committed to. */
  branch?: string;
  /** `owner/repo` for audit. */
  providerId?: string;
  error?: string;
}

export interface SitePrProvider {
  readonly kind: string;
  /** Commit the file + open a PR. Returns an outcome — never throws on a publish failure. */
  openPr(input: SitePrInput): Promise<SitePrOutcome>;
}

/**
 * The non-networked default: returns a deterministic fake PR url so the autonomous flow is exercisable
 * end to end (and the receipt is honest about the dry-run) without a token or a real repo.
 */
export class DryRunSitePrProvider implements SitePrProvider {
  readonly kind = "dryrun" as const;
  constructor(private readonly repo = "ipop/site") {}

  async openPr(input: SitePrInput): Promise<SitePrOutcome> {
    input.onLog(`▸ [dryrun] would commit ${input.path} to ${this.repo}@${input.branch} and open a PR`);
    return {
      status: "ready",
      prUrl: `https://github.com/${this.repo}/pull/dryrun-${input.branch}`,
      branch: input.branch,
      providerId: this.repo,
    };
  }
}

export interface GitHubSitePrOptions {
  /** The site repo as `owner/repo` (e.g. `ipop-ai/site`). Required. */
  repo: string;
  /** Base branch the PR targets (default `main`). */
  baseBranch?: string;
  /**
   * The GitHub token, injected from the per-workspace #192 connection (the internal site-publish
   * connection). When set it ALWAYS wins over the env vars — the token is no longer a Fly server secret
   * but an encrypted per-workspace credential. Omitted ⇒ legacy env fallback (back-compat only).
   */
  token?: string;
}

/**
 * Real provider (#250): commits the file on a new branch and opens a PR via the GitHub REST API.
 * **Dependency-free** (global `fetch`, no SDK) and lazy (only constructed when `sitePrProvider:
 * "github"`). Auth: `REALWORLD_GITHUB_TOKEN` (falls back to `GITHUB_TOKEN` / `GH_TOKEN`) with `repo`
 * scope; the token is read at publish time and never logged. Idempotent-ish: an existing branch is
 * reused (422 on ref-create) and an existing PR for the branch is returned instead of erroring.
 */
export class GitHubSitePrProvider implements SitePrProvider {
  readonly kind = "github" as const;

  private readonly api = "https://api.github.com";
  private readonly repo: string;
  private readonly baseBranch: string;
  private readonly injectedToken?: string;

  constructor(opts: GitHubSitePrOptions) {
    this.repo = opts.repo;
    this.baseBranch = opts.baseBranch?.trim() || "main";
    this.injectedToken = opts.token?.trim() || undefined;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private token(): string {
    // The per-workspace connection token wins; env vars are a back-compat fallback only.
    const token =
      this.injectedToken ||
      process.env.REALWORLD_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;
    if (!token) {
      throw new Error(
        "the internal site-publish connection requires a GitHub token (REALWORLD_GITHUB_TOKEN with repo " +
          "scope) — connect it once in Settings, or run with the default dryrun provider.",
      );
    }
    return token;
  }

  async openPr(input: SitePrInput): Promise<SitePrOutcome> {
    try {
      const headers = this.headers(this.token());
      input.onLog(`▸ [github] committing ${input.path} to ${this.repo}@${input.branch}`);
      const baseSha = await this.baseSha(headers);
      await this.ensureBranch(headers, input.branch, baseSha, input.onLog);
      await this.putFile(headers, input, input.onLog);
      const prUrl = await this.openOrFindPr(headers, input, input.onLog);
      input.onLog(`✓ [github] PR open at ${prUrl}`);
      return { status: "ready", prUrl, branch: input.branch, providerId: this.repo };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The head commit sha of the base branch (the new branch points here initially). */
  private async baseSha(headers: Record<string, string>): Promise<string> {
    const res = await fetch(`${this.api}/repos/${this.repo}/git/ref/heads/${this.baseBranch}`, { headers });
    if (!res.ok) throw new Error(`github get base ref failed: ${res.status} ${await safeBody(res)}`);
    const body = (await res.json()) as { object?: { sha?: string } };
    const sha = body.object?.sha;
    if (!sha) throw new Error(`github base ref ${this.baseBranch} returned no sha`);
    return sha;
  }

  /** Create `refs/heads/<branch>` at `baseSha`; an existing branch (422) is reused (idempotent). */
  private async ensureBranch(
    headers: Record<string, string>,
    branch: string,
    baseSha: string,
    onLog: (l: string) => void,
  ): Promise<void> {
    const res = await fetch(`${this.api}/repos/${this.repo}/git/refs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (res.ok) {
      onLog(`✓ [github] branch ${branch} created`);
      return;
    }
    if (res.status === 422) {
      onLog(`✓ [github] branch ${branch} exists`);
      return;
    }
    throw new Error(`github create branch failed: ${res.status} ${await safeBody(res)}`);
  }

  /** Commit the file on the head branch (overwriting in place on a re-run via the existing blob sha). */
  private async putFile(
    headers: Record<string, string>,
    input: SitePrInput,
    onLog: (l: string) => void,
  ): Promise<void> {
    const url = `${this.api}/repos/${this.repo}/contents/${encodePath(input.path)}`;
    let sha: string | undefined;
    const head = await fetch(`${url}?ref=${encodeURIComponent(input.branch)}`, { headers });
    if (head.ok) {
      const body = (await head.json()) as { sha?: string };
      sha = body.sha;
    }
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: input.title,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`github put file failed: ${res.status} ${await safeBody(res)}`);
    onLog(`✓ [github] ${input.path} ${sha ? "updated" : "committed"}`);
  }

  /** Open a PR base ← head; if one already exists for the branch (422), return it instead. */
  private async openOrFindPr(
    headers: Record<string, string>,
    input: SitePrInput,
    onLog: (l: string) => void,
  ): Promise<string> {
    const res = await fetch(`${this.api}/repos/${this.repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: input.title, head: input.branch, base: this.baseBranch, body: input.body }),
    });
    if (res.ok) {
      const body = (await res.json()) as { html_url?: string };
      if (!body.html_url) throw new Error("github create PR returned no html_url");
      return body.html_url;
    }
    // A PR already exists for this head branch — find and return it (idempotent re-publish).
    if (res.status === 422) {
      const owner = this.repo.split("/")[0] ?? "";
      const list = await fetch(
        `${this.api}/repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`,
        { headers },
      );
      if (list.ok) {
        const prs = (await list.json()) as Array<{ html_url?: string }>;
        const existing = prs[0]?.html_url;
        if (existing) {
          onLog(`✓ [github] PR already open for ${input.branch}`);
          return existing;
        }
      }
    }
    throw new Error(`github create PR failed: ${res.status} ${await safeBody(res)}`);
  }
}

/** Percent-encode each path segment but keep the `/` separators (a repo path is `dir/sub/file.md`). */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function safeBody(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 200);
}
