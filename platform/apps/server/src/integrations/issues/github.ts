import {
  IssueProviderError,
  type IssueContext,
  type IssueProvider,
  type IssueRef,
} from "./types.js";

/** Injected so unit tests run network-free; defaults to the global `fetch` (Node ≥18). */
export interface IssueProviderDeps {
  fetch?: typeof fetch;
  /** API base, overridable for GitHub Enterprise. Default `https://api.github.com`. */
  baseUrl?: string;
}

/** Shape of the bits of the GitHub issues API response we consume. */
interface GitHubIssue {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  labels?: Array<string | { name?: string }>;
  user?: { login?: string };
}

/**
 * GitHub issue provider (#57). `GET /repos/{owner}/{repo}/issues/{n}` serves **issues and PRs**
 * alike, so one read path covers both. The token (resolved per-tenant from the #25 `SecretsResolver`)
 * is sent as a bearer header and never logged; a non-2xx response throws a content-free
 * {@link IssueProviderError}.
 */
export class GitHubIssueProvider implements IssueProvider {
  readonly source = "github" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(deps: IssueProviderDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.baseUrl = (deps.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  private headers(token?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "reload-agent-platform",
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  async fetchIssue(ref: IssueRef, token?: string): Promise<IssueContext> {
    const path = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: this.headers(token) });
    } catch {
      throw new IssueProviderError("github", "request failed");
    }
    if (!res.ok) throw new IssueProviderError("github", `failed to fetch issue (status ${res.status})`);
    const data = (await res.json()) as GitHubIssue;
    return {
      source: "github",
      ref: `github:${ref.owner}/${ref.repo}#${ref.number}`,
      id: String(data.number),
      title: data.title ?? "",
      body: data.body ?? "",
      url: data.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      state: data.state ?? "open",
      labels: (data.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
      author: data.user?.login,
    };
  }

  async postComment(ref: IssueRef, token: string | undefined, body: string): Promise<{ url: string }> {
    const path = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { ...this.headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    } catch {
      throw new IssueProviderError("github", "comment request failed");
    }
    if (!res.ok) throw new IssueProviderError("github", `failed to post comment (status ${res.status})`);
    const data = (await res.json()) as { html_url?: string };
    return { url: data.html_url ?? "" };
  }

  /**
   * Create a new issue (#117) — `POST /repos/{owner}/{repo}/issues`. The body is already redacted by the
   * flywheel before it reaches here (#25), and the token is sent as a bearer header, never logged. A
   * non-2xx throws a content-free {@link IssueProviderError}. Additive to #57 (read + comment only).
   */
  async createIssue(
    target: { owner: string; repo: string },
    token: string | undefined,
    input: { title: string; body: string; labels?: string[] },
  ): Promise<{ number: number; ref: string; state: string; url: string }> {
    const path = `/repos/${target.owner}/${target.repo}/issues`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { ...this.headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
      });
    } catch {
      throw new IssueProviderError("github", "create issue request failed");
    }
    if (!res.ok) throw new IssueProviderError("github", `failed to create issue (status ${res.status})`);
    const data = (await res.json()) as GitHubIssue;
    return {
      number: data.number,
      ref: `github:${target.owner}/${target.repo}#${data.number}`,
      state: data.state ?? "open",
      url: data.html_url ?? `https://github.com/${target.owner}/${target.repo}/issues/${data.number}`,
    };
  }

  /**
   * Reopen an issue (#117) — `PATCH /repos/{owner}/{repo}/issues/{n}` with `state: "open"`. Used when a
   * fixed fingerprint recurs (the #106 outcome verifier). Returns the resulting state.
   */
  async reopenIssue(ref: IssueRef, token?: string): Promise<{ state: string }> {
    const path = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "PATCH",
        headers: { ...this.headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "open" }),
      });
    } catch {
      throw new IssueProviderError("github", "reopen request failed");
    }
    if (!res.ok) throw new IssueProviderError("github", `failed to reopen issue (status ${res.status})`);
    const data = (await res.json()) as { state?: string };
    return { state: data.state ?? "open" };
  }
}
