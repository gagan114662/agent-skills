import type { PublishProvider } from "./provider.js";
import { DryRunPublishProvider } from "./dry-run-provider.js";

/**
 * Publish-provider factory (#231). An injected provider (a test fake) always wins. Otherwise the real
 * GitHub Pages provider is `await import()`-ed lazily ONLY when `kind === "github_pages"` — so its
 * runtime cost (and the token requirement) never touches the default dry-run path. Anything else is the
 * non-reachable {@link DryRunPublishProvider}.
 */
export async function createPublishProvider(
  kind: string,
  override?: PublishProvider,
): Promise<PublishProvider> {
  if (override) return override;
  if (kind === "github_pages") {
    const { GitHubPagesPublishProvider } = await import("./github-pages-provider.js");
    // #338: route the post-publish build-wait poll through the durable engine when enabled (owner-first);
    // default OFF ⇒ the provider's legacy in-process poll runs unchanged. Lazy so the DB store stays off
    // the default dry-run path.
    const { defaultPublishBuildWait } = await import("./durable-build-wait.js");
    return new GitHubPagesPublishProvider(defaultPublishBuildWait());
  }
  return new DryRunPublishProvider();
}
