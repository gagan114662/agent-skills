import type { ChecksResult, CreatePrInput, GitHubProvider, PullRequestRef } from "./provider.js";

/** Thrown when a GitHub action is attempted with no provider configured. Routes map it to 501. */
export class GitHubUnavailableError extends Error {
  constructor(message = "github provider not configured") {
    super(message);
    this.name = "GitHubUnavailableError";
  }
}

/**
 * The default provider (#51): GitHub is not configured, so every action fails with a typed
 * {@link GitHubUnavailableError}. It holds no credentials, so the default deployment and all of CI
 * never touch GitHub. Set `GITHUB_PROVIDER=gh` to enable the real `gh`-CLI adapter.
 */
export class NoneGitHubProvider implements GitHubProvider {
  readonly kind = "none" as const;

  createPullRequest(_input: CreatePrInput): Promise<PullRequestRef> {
    return Promise.reject(new GitHubUnavailableError());
  }

  getChecks(): Promise<ChecksResult> {
    return Promise.reject(new GitHubUnavailableError());
  }

  getFailingLogs(): Promise<string> {
    return Promise.reject(new GitHubUnavailableError());
  }
}
