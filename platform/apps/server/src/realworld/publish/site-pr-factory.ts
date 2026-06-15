import type { SitePrProvider } from "./site-pr-provider.js";
import { DryRunSitePrProvider } from "./site-pr-provider.js";

/**
 * Site-PR provider factory (#250). An injected provider (a test fake) always wins. Otherwise the real
 * {@link GitHubSitePrProvider} is selected ONLY when `kind === "github"` AND a `repo` is configured —
 * its token requirement never touches the default dry-run path. Anything else is the non-networked
 * {@link DryRunSitePrProvider}. The GitHub provider is `await import()`-ed lazily.
 */
export async function createSitePrProvider(
  kind: string,
  opts: { repo?: string; baseBranch?: string; override?: SitePrProvider } = {},
): Promise<SitePrProvider> {
  if (opts.override) return opts.override;
  if (kind === "github" && opts.repo) {
    const { GitHubSitePrProvider } = await import("./site-pr-provider.js");
    return new GitHubSitePrProvider({ repo: opts.repo, baseBranch: opts.baseBranch });
  }
  return new DryRunSitePrProvider(opts.repo);
}
