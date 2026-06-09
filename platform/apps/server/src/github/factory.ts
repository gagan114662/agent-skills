import { GhCliGitHubProvider } from "./gh-cli.js";
import { NoneGitHubProvider } from "./none.js";
import type { GitHubProvider } from "./provider.js";

/**
 * Select the GitHub provider from env (#51). Default `none` — no credentials, so CI/tests never call
 * GitHub. `GITHUB_PROVIDER=gh` enables the real `gh`-CLI adapter (operational opt-in).
 */
export function createGitHubProvider(source: NodeJS.ProcessEnv = process.env): GitHubProvider {
  return source.GITHUB_PROVIDER === "gh" ? new GhCliGitHubProvider() : new NoneGitHubProvider();
}
