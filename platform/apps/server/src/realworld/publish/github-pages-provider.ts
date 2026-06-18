import type { PublishInput, PublishOutcome, PublishProvider } from "./provider.js";
import type { PublishBuildWait } from "../../durable-workflow/publish-wait.js";

/**
 * Real publish provider (#231): publishes a self-contained HTML page to **GitHub Pages** and returns a
 * live `https://<owner>.github.io/<repo>/` URL. **Dependency-free** (the GitHub REST API over global
 * `fetch`, no SDK) and **lazy** (only constructed when `publishProvider: "github_pages"`). Idempotent —
 * an existing repo / already-enabled Pages site is treated as success and the page is updated in place.
 *
 * Auth: `REALWORLD_GITHUB_TOKEN` (falls back to `GITHUB_TOKEN` / `GH_TOKEN`). The token needs `repo`
 * scope (public repo + Pages). The token is read at publish time and never logged.
 *
 * This is the lowest-dependency way to take a page's BYTES to a real reachable URL with no managed
 * platform account beyond a GitHub token the owner already has.
 */
export class GitHubPagesPublishProvider implements PublishProvider {
  readonly kind = "github_pages" as const;

  /**
   * Optional durable build-wait (#338). When injected AND enabled for the publishing workspace (owner-first
   * flag), the post-publish "wait for the Pages build" poll runs through the durable engine — suspending +
   * backing off + persisting state across ticks/restarts — instead of the legacy 120s in-process blocking
   * poll. Absent or flag-OFF ⇒ the legacy loop runs byte-for-byte (today's behavior is unchanged).
   */
  constructor(private readonly buildWait?: PublishBuildWait) {}

  private readonly api = "https://api.github.com";
  private readonly headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  });

  private token(): string {
    const token =
      process.env.REALWORLD_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      throw new Error(
        'publishProvider: "github_pages" requires REALWORLD_GITHUB_TOKEN (or GITHUB_TOKEN / GH_TOKEN) ' +
          "with repo scope, or run with the default dryrun provider.",
      );
    }
    return token;
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    try {
      const token = this.token();
      const headers = this.headers(token);
      const repo = sanitizeRepo(input.slug);

      const owner = await this.login(headers);
      input.onLog(`▸ [github_pages] publishing to ${owner}/${repo}`);
      await this.ensureRepo(headers, repo, input.onLog);
      await this.putIndex(headers, owner, repo, input.html, input.onLog);
      await this.enablePages(headers, owner, repo, input.onLog);
      const url = await this.waitForBuild(headers, owner, repo, input.onLog, input.workspaceId);

      input.onLog(`✓ [github_pages] live at ${url}`);
      return { status: "ready", url, providerId: `${owner}/${repo}` };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }

  async healthCheck(url: string): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await fetch(url, { method: "GET", redirect: "follow" });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  private async login(headers: Record<string, string>): Promise<string> {
    const res = await fetch(`${this.api}/user`, { headers });
    if (!res.ok) throw new Error(`github /user failed: ${res.status} ${await safeBody(res)}`);
    const body = (await res.json()) as { login?: string };
    if (!body.login) throw new Error("github /user returned no login");
    return body.login;
  }

  private async ensureRepo(
    headers: Record<string, string>,
    repo: string,
    onLog: (l: string) => void,
  ): Promise<void> {
    const res = await fetch(`${this.api}/user/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: repo,
        private: false,
        auto_init: true,
        description: "Published by the fleet (#231 real-world tool surface)",
      }),
    });
    if (res.ok) {
      onLog(`✓ [github_pages] repo ${repo} created`);
      return;
    }
    // 422 = name already exists for this owner — idempotent re-publish.
    if (res.status === 422) {
      onLog(`✓ [github_pages] repo ${repo} exists`);
      return;
    }
    throw new Error(`github repo create failed: ${res.status} ${await safeBody(res)}`);
  }

  private async putIndex(
    headers: Record<string, string>,
    owner: string,
    repo: string,
    html: string,
    onLog: (l: string) => void,
  ): Promise<void> {
    const path = `${this.api}/repos/${owner}/${repo}/contents/index.html`;
    // Look up the existing blob sha (required to overwrite on a re-publish).
    let sha: string | undefined;
    const head = await fetch(path, { headers });
    if (head.ok) {
      const body = (await head.json()) as { sha?: string };
      sha = body.sha;
    }
    const res = await fetch(path, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: "Publish index.html (#231)",
        content: Buffer.from(html, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`github put index.html failed: ${res.status} ${await safeBody(res)}`);
    onLog(`✓ [github_pages] index.html ${sha ? "updated" : "committed"}`);
  }

  private async enablePages(
    headers: Record<string, string>,
    owner: string,
    repo: string,
    onLog: (l: string) => void,
  ): Promise<void> {
    const res = await fetch(`${this.api}/repos/${owner}/${repo}/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: { branch: "main", path: "/" } }),
    });
    if (res.ok || res.status === 409) {
      onLog(`✓ [github_pages] pages ${res.status === 409 ? "already enabled" : "enabled"}`);
      return;
    }
    throw new Error(`github enable pages failed: ${res.status} ${await safeBody(res)}`);
  }

  /**
   * Wait for the GitHub Pages build to go live and return the URL. Routes through the durable engine (#338)
   * when an injected {@link PublishBuildWait} is enabled for this workspace (owner-first flag) — the poll
   * then suspends/backs-off/persists across attempts; otherwise the legacy 120s in-process loop runs
   * byte-for-byte. Both share {@link pollPagesStatus}, so the externally-observed behavior (log lines,
   * built URL, deterministic fallback) is identical — only the WAITING mechanism changes behind the flag.
   */
  private async waitForBuild(
    headers: Record<string, string>,
    owner: string,
    repo: string,
    onLog: (l: string) => void,
    workspaceId: string,
  ): Promise<string> {
    const fallbackUrl = `https://${owner}.github.io/${repo}/`;
    if (this.buildWait && this.buildWait.enabledFor(workspaceId)) {
      let lastStatus = "";
      return this.buildWait.run({
        workspaceId,
        key: `${owner}/${repo}`,
        fallbackUrl,
        onLog,
        poll: async () => {
          const r = await this.pollPagesStatus(headers, owner, repo);
          if (r.status && r.status !== lastStatus) {
            lastStatus = r.status;
            onLog(`  [github_pages] build status: ${r.status}`);
          }
          return r.url;
        },
      });
    }
    return this.legacyWaitForBuild(headers, owner, repo, onLog, fallbackUrl);
  }

  /** ONE poll of the Pages build status. Returns the live URL when built, else null (still building). */
  private async pollPagesStatus(
    headers: Record<string, string>,
    owner: string,
    repo: string,
  ): Promise<{ url: string | null; status: string }> {
    const res = await fetch(`${this.api}/repos/${owner}/${repo}/pages`, { headers });
    if (!res.ok) return { url: null, status: "" };
    const body = (await res.json()) as { status?: string; html_url?: string };
    const status = body.status ?? "";
    if (status === "built" && body.html_url) return { url: normalizeUrl(body.html_url), status };
    return { url: null, status };
  }

  /** The original in-process blocking poll — preserved as the flag-OFF default (today's behavior). */
  private async legacyWaitForBuild(
    headers: Record<string, string>,
    owner: string,
    repo: string,
    onLog: (l: string) => void,
    fallbackUrl: string,
  ): Promise<string> {
    const deadline = Date.now() + 120_000; // Pages builds can take ~30–90s on first publish.
    let lastStatus = "";
    while (Date.now() < deadline) {
      const r = await this.pollPagesStatus(headers, owner, repo);
      if (r.status && r.status !== lastStatus) {
        lastStatus = r.status;
        onLog(`  [github_pages] build status: ${r.status}`);
      }
      if (r.url) return r.url;
      await sleep(3000);
    }
    // Fall back to the deterministic Pages URL — the page is committed even if the build poll timed out.
    return fallbackUrl;
  }
}

function sanitizeRepo(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return cleaned || "site";
}

function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function safeBody(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
