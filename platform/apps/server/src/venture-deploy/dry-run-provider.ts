import type {
  ProvisionTargetInput,
  ProvisionTargetOutcome,
  VentureInfraProvider,
} from "./provider.js";

/**
 * The default, **no-cloud-spend** infra provider (#195). It mints deterministic, tenant-scoped preview
 * and prod URLs, echoes any injected secret into `onLog` (so the caller's redaction test is real), and
 * records its calls — so tests, CI, and the demo never touch a cloud account. The real backends are
 * `FlyInfraProvider` / `VercelInfraProvider` behind lazy fetch/SDK loads.
 *
 * It is also the seam for controllable behavior in tests: `failNext` forces a provisioning error, and
 * the per-venture `projects` map proves idempotency (re-provisioning the same slug returns the same id).
 */
export class DryRunInfraProvider implements VentureInfraProvider {
  readonly kind = "dryrun" as const;

  /** Calls recorded for assertions (no cloud side effects). */
  readonly provisioned: ProvisionTargetInput[] = [];
  readonly tornDown: string[] = [];

  /** When set, the next `provisionTarget` rejects (then resets). */
  failNext?: string;
  /** A flat per-setup cost the dry-run provider reports (default 0 — free). */
  setupCents = 0;

  /** slug → minted projectId, so a re-provision of the same slug is byte-identical (idempotent). */
  private readonly projects = new Map<string, string>();
  private seq = 0;

  provisionTarget(input: ProvisionTargetInput): Promise<ProvisionTargetOutcome> {
    this.provisioned.push(input);
    input.onLog(`▸ provisioning dryrun target for ${input.slug}`);
    // Echo the injected secrets so a leaked value WOULD show up here — the caller's redactor must scrub it.
    for (const [k, v] of Object.entries(input.secrets)) input.onLog(`  secret ${k}=${v}`);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      return Promise.reject(new Error(error));
    }
    const projectId = this.projects.get(input.slug) ?? `proj_${input.slug}_${++this.seq}`;
    this.projects.set(input.slug, projectId);
    const outcome: ProvisionTargetOutcome = {
      projectId,
      previewUrl: `https://${input.slug}-preview.dryrun.reload.app`,
      prodUrl: `https://${input.slug}.dryrun.reload.app`,
      estimatedSetupCents: this.setupCents,
    };
    input.onLog(`✓ target ready: ${outcome.prodUrl}`);
    return Promise.resolve(outcome);
  }

  teardownTarget(projectId: string): Promise<void> {
    this.tornDown.push(projectId);
    for (const [slug, id] of this.projects) if (id === projectId) this.projects.delete(slug);
    return Promise.resolve();
  }
}
