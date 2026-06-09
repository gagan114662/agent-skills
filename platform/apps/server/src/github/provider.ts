import type { ChecksStatus, CheckRunDto, PullRequestState } from "@reload/shared";

/** Input to open a PR from a session branch. No client string reaches a shell — argv only. */
export interface CreatePrInput {
  /** The repo the PR is opened in (the worktree's source repo). */
  repoRoot: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft: boolean;
}

/** What a provider returns after opening a PR. */
export interface PullRequestRef {
  number: number;
  url: string;
  state: Extract<PullRequestState, "open" | "draft">;
}

/** Where on the host a checks/log query runs, plus the PR/branch it targets. */
export interface ChecksQuery {
  repoRoot: string;
  headBranch: string;
  prNumber?: number | null;
}

/** A provider's checks rollup: the per-run detail plus a single status for the PR row. */
export interface ChecksResult {
  status: ChecksStatus;
  runs: CheckRunDto[];
}

/**
 * The GitHub seam (#51): create a PR, read its checks, and fetch failing logs to forward to the
 * agent. Real impl shells `gh` (behind config); the `none` default has no credentials so CI/tests
 * never call GitHub — exactly the #25 SandboxProvider discipline.
 */
export interface GitHubProvider {
  readonly kind: "none" | "gh";
  createPullRequest(input: CreatePrInput): Promise<PullRequestRef>;
  getChecks(query: ChecksQuery): Promise<ChecksResult>;
  /** Failing CI logs (or a summary) to forward to the agent as a "fix CI" task. */
  getFailingLogs(query: ChecksQuery): Promise<string>;
}
