export interface PublishReadiness {
  provider: string;
  live: boolean;
  dryRun: boolean;
}

export function resolvePublishReadiness(provider: string | undefined): PublishReadiness {
  const kind = provider ?? "dryrun";
  const live = kind === "github_pages";
  return {
    provider: kind,
    live,
    dryRun: !live,
  };
}
