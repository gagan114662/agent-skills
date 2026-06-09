import { spawn } from "node:child_process";
import { rollupChecks } from "./checks.js";
import type {
  ChecksQuery,
  ChecksResult,
  CreatePrInput,
  GitHubProvider,
  PullRequestRef,
} from "./provider.js";
import type { CheckRunDto } from "@reload/shared";

/** Runs a host command with an explicit argv (no shell). Injectable so it can be faked in a test. */
export interface CommandRunner {
  run(cmd: string, args: string[], opts: { cwd: string }): Promise<{ stdout: string; stderr: string; code: number }>;
}

class SpawnCommandRunner implements CommandRunner {
  run(cmd: string, args: string[], opts: { cwd: string }) {
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  }
}

/** A `gh pr checks --json` run as GitHub reports it. */
interface GhCheck {
  name?: string;
  state?: string;
  bucket?: string;
  link?: string;
}

/**
 * The real GitHub adapter (#51), enabled by `GITHUB_PROVIDER=gh`. It pushes the session branch and
 * shells the `gh` CLI, which carries its own auth from the execution environment — the token is
 * **never** read into a row, log, or response. This path is never exercised in CI (no remote, no
 * token), exactly like the `@vercel/sandbox` adapter in #25; it is config-gated and typechecked.
 */
export class GhCliGitHubProvider implements GitHubProvider {
  readonly kind = "gh" as const;

  constructor(private readonly cmd: CommandRunner = new SpawnCommandRunner()) {}

  async createPullRequest(input: CreatePrInput): Promise<PullRequestRef> {
    // Publish the branch so GitHub can open a PR from it.
    await this.gh("git", ["push", "-u", "origin", input.headBranch], input.repoRoot);
    const args = [
      "pr",
      "create",
      "--base",
      input.baseBranch,
      "--head",
      input.headBranch,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) args.push("--draft");
    await this.gh("gh", args, input.repoRoot);
    // Read back the structured PR fields (create only prints the URL).
    const view = await this.gh(
      "gh",
      ["pr", "view", input.headBranch, "--json", "number,url,isDraft"],
      input.repoRoot,
    );
    const pr = JSON.parse(view) as { number: number; url: string; isDraft: boolean };
    return { number: pr.number, url: pr.url, state: pr.isDraft ? "draft" : "open" };
  }

  async getChecks(query: ChecksQuery): Promise<ChecksResult> {
    const out = await this.gh(
      "gh",
      ["pr", "checks", query.headBranch, "--json", "name,state,bucket,link"],
      query.repoRoot,
    );
    const raw = (JSON.parse(out || "[]") as GhCheck[]) ?? [];
    const runs: CheckRunDto[] = raw.map((c) => ({
      name: c.name ?? "check",
      status: c.bucket === "pending" ? "in_progress" : "completed",
      conclusion: mapConclusion(c.bucket ?? c.state),
      detailsUrl: c.link ?? null,
    }));
    return { status: rollupChecks(runs), runs };
  }

  async getFailingLogs(query: ChecksQuery): Promise<string> {
    const checks = await this.getChecks(query);
    const failing = checks.runs.filter((r) => r.conclusion === "failure");
    if (failing.length === 0) return "No failing checks.";
    return failing.map((r) => `✗ ${r.name}${r.detailsUrl ? ` — ${r.detailsUrl}` : ""}`).join("\n");
  }

  private async gh(cmd: string, args: string[], cwd: string): Promise<string> {
    const r = await this.cmd.run(cmd, args, { cwd });
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }
}

function mapConclusion(bucket: string | undefined): CheckRunDto["conclusion"] {
  switch (bucket) {
    case "pass":
    case "success":
      return "success";
    case "fail":
    case "failure":
      return "failure";
    case "skipping":
    case "skipped":
      return "skipped";
    case "cancel":
    case "cancelled":
      return "cancelled";
    case "pending":
      return null;
    default:
      return "neutral";
  }
}
