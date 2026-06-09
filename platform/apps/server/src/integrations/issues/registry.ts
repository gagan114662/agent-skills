import { GitHubIssueProvider, type IssueProviderDeps } from "./github.js";
import { LinearIssueProvider } from "./linear.js";
import { IssueRefError, type IssueProvider, type IssueRef, type IssueSource } from "./types.js";

/** A map of every issue provider, keyed by source. */
export type IssueProviders = Record<IssueSource, IssueProvider>;

/** Build the default real providers (GitHub REST + Linear GraphQL), both over an injectable `fetch`. */
export function defaultIssueProviders(deps: IssueProviderDeps = {}): IssueProviders {
  return {
    github: new GitHubIssueProvider(deps),
    linear: new LinearIssueProvider(deps),
  };
}

/** Pick the provider for a parsed ref. Throws {@link IssueRefError} if none is registered. */
export function resolveIssueProvider(ref: IssueRef, providers: IssueProviders): IssueProvider {
  const provider = providers[ref.source];
  if (!provider) throw new IssueRefError(`no provider for source "${ref.source}"`);
  return provider;
}

/** The secret key (resolved per-tenant) that carries each provider's token. Never in config. */
export const PROVIDER_TOKEN_KEYS: Record<IssueSource, string> = {
  github: "GITHUB_TOKEN",
  linear: "LINEAR_API_KEY",
};
