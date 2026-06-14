import type { PublishInput, PublishOutcome, PublishProvider } from "./provider.js";

/**
 * The default publish provider (#231): mints a deterministic, NON-reachable URL and pushes no bytes.
 * Safe for tests + the default-OFF posture — the fleet can model a publish without touching the world.
 * Mirrors the #195/#73 dry-run hosts (`*.dryrun.reload.app`).
 */
export class DryRunPublishProvider implements PublishProvider {
  readonly kind = "dryrun" as const;

  async publish(input: PublishInput): Promise<PublishOutcome> {
    input.onLog(`▸ [dryrun] would publish ${input.html.length} bytes for ${input.slug}`);
    const url = `https://${input.slug}.dryrun.reload.app`;
    input.onLog(`✓ [dryrun] ${url} (not reachable — dry run)`);
    return { status: "ready", url, providerId: `dryrun/${input.slug}` };
  }

  async healthCheck(): Promise<{ ok: boolean; status: number }> {
    // Dry-run URLs are intentionally unreachable; report not-ok without a network call.
    return { ok: false, status: 0 };
  }
}
