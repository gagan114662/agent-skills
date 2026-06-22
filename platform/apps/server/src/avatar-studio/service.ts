/**
 * The AI UGC avatar studio service (issue #741) — the step the fleet calls to get a recurring on-camera persona.
 * It renders a {@link AvatarPersona} into a concrete {@link RenderedAvatar} over the persisted
 * {@link AvatarStudioStore} and guarantees:
 *
 *   1. PERSONA CONSISTENCY — the same `avatarId` always resolves to the same face + voice. Two layers enforce it:
 *      the pure derivation is deterministic, and the store returns the FIRST render on every subsequent call, so
 *      even a non-deterministic live provider is pinned after its first render.
 *   2. SAFE BY DEFAULT — the studio is OFF unless explicitly enabled for the workspace, and the default provider
 *      is the deterministic {@link FakeAvatarProvider}, so no external call happens until both are flipped.
 *   3. PROVIDER FALLBACK — if the wired provider returns `null` or throws, the service falls back to the
 *      deterministic derivation, so a render never fails and consistency is never broken by a flaky API.
 *
 * Like the #272 ads service it does no IO except through the injected store, provider, and `now` seams, touches no
 * migration / schema barrel / app-wiring registry, and is fail-closed on enablement.
 */

import {
  isAvatarStudioEnabledForWorkspace,
  resolveAvatarStudioCaps,
  type AvatarStudioCaps,
} from "./caps.js";
import { FakeAvatarProvider, type AvatarProvider } from "./provider.js";
import { deriveAvatarConfig } from "./render.js";
import type { AvatarStudioStore, StoredAvatar } from "./store.js";
import type { AvatarConfig, AvatarPersona, RenderedAvatar } from "./types.js";

export interface AvatarStudioDeps {
  store: AvatarStudioStore;
  /** The render provider. Defaults to the deterministic, offline {@link FakeAvatarProvider}. */
  provider?: AvatarProvider;
  /** Resolved caps. Defaults to the env-resolved caps. */
  caps?: AvatarStudioCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** The input the fleet passes to {@link AvatarStudioService.render}. */
export interface RenderInput {
  workspaceId: string;
  persona: AvatarPersona;
  /** The member/agent on whose behalf the render runs (recorded as the requester). */
  requesterMemberId?: string | null;
}

export class AvatarStudioService {
  private readonly store: AvatarStudioStore;
  private readonly provider: AvatarProvider;
  private readonly caps: AvatarStudioCaps;
  private readonly now: () => Date;

  constructor(deps: AvatarStudioDeps) {
    this.store = deps.store;
    this.provider = deps.provider ?? new FakeAvatarProvider();
    this.caps = deps.caps ?? resolveAvatarStudioCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint or dry-run. */
  get policy(): AvatarStudioCaps {
    return this.caps;
  }

  /** Whether the studio is offered for a workspace (pure, fail-closed). */
  isEnabledFor(workspaceId: string): boolean {
    return isAvatarStudioEnabledForWorkspace(this.caps, workspaceId);
  }

  /**
   * Render (or return the already-rendered) avatar for a persona.
   *
   *  - Refuses when the studio is disabled for the workspace (fail-closed, owner-first rollout).
   *  - Refuses a blank `avatarId` (a "missing avatar" — nothing stable to seed from).
   *  - If the avatar was rendered before, returns the STORED config unchanged (persona consistency).
   *  - Otherwise asks the provider; on `null`/throw it FALLS BACK to the deterministic derivation, persists the
   *    result, and returns it. The recorded `provider` reflects which path produced the config.
   */
  async render(input: RenderInput): Promise<RenderedAvatar> {
    const { workspaceId, persona } = input;
    if (!this.isEnabledFor(workspaceId)) {
      throw new AvatarStudioError("avatar studio is disabled for this workspace");
    }
    const avatarId = persona.avatarId.trim();
    if (avatarId.length === 0) {
      throw new AvatarStudioError("persona.avatarId is required");
    }

    const existing = await this.store.getByAvatarId(workspaceId, avatarId);
    if (existing) return toRendered(existing);

    const normalized: AvatarPersona = { ...persona, avatarId };
    const { config, providerName } = await this.renderConfig(normalized);

    const stored = await this.store.create({
      workspaceId,
      avatarId,
      displayName: persona.displayName,
      config,
      provider: providerName,
      requestedByMemberId: input.requesterMemberId ?? null,
      createdAt: this.now(),
    });
    return toRendered(stored);
  }

  /** A preview of what a persona WOULD render to, without enablement checks or persistence (always deterministic). */
  preview(persona: AvatarPersona): AvatarConfig {
    return deriveAvatarConfig(persona);
  }

  /** Load one rendered avatar by its stable id. Null when it was never rendered ("missing avatar"). */
  async get(workspaceId: string, avatarId: string): Promise<RenderedAvatar | null> {
    const row = await this.store.getByAvatarId(workspaceId, avatarId);
    return row ? toRendered(row) : null;
  }

  /** A workspace's studio (rendered avatars), newest first. */
  async list(workspaceId: string): Promise<RenderedAvatar[]> {
    const rows = await this.store.list(workspaceId);
    return rows.map(toRendered);
  }

  /** Ask the provider for a config; fall back to the deterministic derivation on null/throw. */
  private async renderConfig(persona: AvatarPersona): Promise<{ config: AvatarConfig; providerName: string }> {
    try {
      const config = await this.provider.render(persona);
      if (config) return { config, providerName: this.provider.name };
    } catch {
      // Swallow the provider error and fall back — a flaky API must never break a render or persona consistency.
    }
    return { config: deriveAvatarConfig(persona), providerName: "fake" };
  }
}

function toRendered(row: StoredAvatar): RenderedAvatar {
  return {
    avatarId: row.avatarId,
    displayName: row.displayName,
    config: row.config,
    provider: row.provider,
  };
}

/** An avatar-studio operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class AvatarStudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarStudioError";
  }
}
