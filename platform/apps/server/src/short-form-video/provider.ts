/**
 * The render seam for the short-form video agent (#740). A {@link VideoProvider} takes a {@link RenderSpec}
 * (the pure, brief-grounded script) and returns a {@link RenderedVideo} asset. The seam is injected so the
 * service is testable with no network and so a real renderer (e.g. a hosted text-to-video API) can be wired
 * in a later change WITHOUT touching the service or the pure core.
 *
 * The ONLY provider shipped today is {@link FakeVideoProvider}: fully deterministic and 100% offline — it
 * derives a stable asset id from a hash of the script, so the same script always yields the same asset and
 * NO external call ever happens until a real provider is deliberately wired in. That is what makes the
 * feature safe to ship default-OFF: enabling it cannot, by itself, cause a network call or a spend.
 */

import type { RenderSpec, RenderedVideo } from "./types.js";

/** The narrow render seam the service depends on. */
export interface VideoProvider {
  /** A stable id for this provider (recorded on every asset for the audit trail). */
  readonly id: string;
  /** Whether this provider can make external calls. The fake provider is offline (`false`). */
  readonly live: boolean;
  /** Render a script into a video asset. May reject — the service degrades to `script_only` on failure. */
  render(spec: RenderSpec): Promise<RenderedVideo>;
}

/**
 * A deterministic 32-bit string hash (djb2). Pure and stable across runs — used to mint a reproducible fake
 * asset id from the script so the fake provider needs neither randomness nor a clock.
 */
function hashScript(spec: RenderSpec): string {
  const material = JSON.stringify({
    workspaceId: spec.workspaceId,
    topic: spec.topic,
    hook: spec.script.hook,
    scenes: spec.script.scenes.map((s) => [s.narration, s.onScreenText, s.durationSeconds]),
    cta: spec.script.callToAction,
  });
  let hash = 5381;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) + hash + material.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The default, offline provider. Produces a deterministic asset whose id/url derive from a hash of the
 * script. Never makes a network call and never spends — so the agent is fully exercisable (and demoable)
 * before any real text-to-video backend exists.
 */
export class FakeVideoProvider implements VideoProvider {
  readonly id = "fake";
  readonly live = false;

  async render(spec: RenderSpec): Promise<RenderedVideo> {
    const digest = hashScript(spec);
    const assetId = `fake-video-${digest}`;
    return {
      assetId,
      url: `memory://short-form-video/${spec.workspaceId}/${assetId}.mp4`,
      thumbnailUrl: `memory://short-form-video/${spec.workspaceId}/${assetId}.jpg`,
      format: "mp4",
      durationSeconds: spec.script.totalDurationSeconds,
      provider: this.id,
    };
  }
}
