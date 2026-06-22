/**
 * The avatar render provider seam (issue #741). A provider turns a {@link AvatarPersona} into a concrete
 * {@link AvatarConfig}. The shipped default is the deterministic {@link FakeAvatarProvider}, which calls NOTHING
 * external — so until a deployment both enables the studio AND wires a live provider, no money is spent and no
 * network request is made (the conservative #272 `DryRunAdsProvider` posture).
 *
 * The contract for a live provider: return a config, or `null` when it cannot render (mis-config, transient
 * failure). The {@link AvatarStudioService} treats `null` (and any thrown error) as a signal to FALL BACK to the
 * deterministic derivation, so a render always succeeds and persona consistency is never broken by a flaky API.
 */

import { deriveAvatarConfig } from "./render.js";
import type { AvatarConfig, AvatarPersona } from "./types.js";

export interface AvatarProvider {
  /** Provider name, recorded on every rendered avatar (`"fake"` for the deterministic default). */
  readonly name: string;
  /** Whether this provider makes real (external) renders. `false` for the deterministic fake. */
  readonly live: boolean;
  /** Produce a config for the persona, or `null` if it cannot (→ the service falls back to deterministic). */
  render(persona: AvatarPersona): Promise<AvatarConfig | null>;
}

/**
 * The production default: a deterministic, offline provider. The same `avatarId` always renders the same face +
 * voice, with zero external calls. This is what makes the whole feature safe to ship default-ON-code/default-OFF-
 * spend — nothing leaves the process until a real provider is deliberately wired.
 */
export class FakeAvatarProvider implements AvatarProvider {
  readonly name = "fake";
  readonly live = false;
  async render(persona: AvatarPersona): Promise<AvatarConfig> {
    return deriveAvatarConfig(persona);
  }
}

/** A provider that never produces a config — useful to exercise the service's fallback path in tests. */
export class NullAvatarProvider implements AvatarProvider {
  readonly name = "null";
  readonly live = true;
  async render(): Promise<AvatarConfig | null> {
    return null;
  }
}
