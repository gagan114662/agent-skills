/**
 * Unit tests for the avatar-studio service (#741) over the in-memory store. Exercises the full contract:
 * default-OFF gating, owner-workspace-first scope, persona consistency (re-render returns the first config even
 * under a live/non-deterministic provider), provider fallback (null/throw → deterministic), the missing-avatar
 * cases, and workspace (IDOR) scoping.
 */

import { describe, it, expect } from "vitest";
import {
  AvatarStudioService,
  AvatarStudioError,
} from "../../src/avatar-studio/service.js";
import { InMemoryAvatarStudioStore } from "../../src/avatar-studio/store.js";
import { NullAvatarProvider, type AvatarProvider } from "../../src/avatar-studio/provider.js";
import { AVATAR_STUDIO_DEFAULTS, type AvatarStudioCaps } from "../../src/avatar-studio/caps.js";
import { deriveAvatarConfig } from "../../src/avatar-studio/render.js";
import type { AvatarConfig, AvatarPersona } from "../../src/avatar-studio/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";

/** Caps with the studio enabled for ALL workspaces (the test default). */
const ENABLED: AvatarStudioCaps = { enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: null };

const PERSONA: AvatarPersona = { avatarId: "mascot", displayName: "Mascot", locale: "en-US" };

function svc(opts: { caps?: AvatarStudioCaps; provider?: AvatarProvider } = {}) {
  return new AvatarStudioService({
    store: new InMemoryAvatarStudioStore(),
    caps: opts.caps ?? ENABLED,
    provider: opts.provider,
    now: () => new Date(0),
  });
}

/** A provider that yields a caller-chosen config the FIRST time and a DIFFERENT one after — to prove pinning. */
class DriftingProvider implements AvatarProvider {
  readonly name = "drift";
  readonly live = true;
  private calls = 0;
  async render(): Promise<AvatarConfig> {
    this.calls += 1;
    const tag = `drift-${this.calls}`;
    const base = deriveAvatarConfig({ avatarId: tag, displayName: tag });
    return base;
  }
}

/** A provider that always throws — models a flaky live API. */
class ThrowingProvider implements AvatarProvider {
  readonly name = "boom";
  readonly live = true;
  async render(): Promise<AvatarConfig> {
    throw new Error("upstream avatar API exploded");
  }
}

describe("default-OFF gating", () => {
  it("is disabled by env defaults and refuses to render", async () => {
    expect(AVATAR_STUDIO_DEFAULTS.enabled).toBe(false);
    const s = svc({ caps: AVATAR_STUDIO_DEFAULTS });
    expect(s.isEnabledFor(WID)).toBe(false);
    await expect(s.render({ workspaceId: WID, persona: PERSONA })).rejects.toBeInstanceOf(AvatarStudioError);
  });

  it("owner-workspace-first: only the owner workspace is in scope", async () => {
    const caps: AvatarStudioCaps = { enabled: true, ownerWorkspaceOnly: true, ownerWorkspaceId: WID };
    const s = svc({ caps });
    expect(s.isEnabledFor(WID)).toBe(true);
    expect(s.isEnabledFor(OTHER_WID)).toBe(false);
    await expect(s.render({ workspaceId: OTHER_WID, persona: PERSONA })).rejects.toBeInstanceOf(
      AvatarStudioError,
    );
  });

  it("preview works regardless of enablement (no gate, no persistence)", () => {
    const s = svc({ caps: AVATAR_STUDIO_DEFAULTS });
    expect(s.preview(PERSONA)).toEqual(deriveAvatarConfig(PERSONA));
  });
});

describe("rendering & persona consistency", () => {
  it("renders deterministically with the default fake provider", async () => {
    const s = svc();
    const r = await s.render({ workspaceId: WID, persona: PERSONA });
    expect(r.provider).toBe("fake");
    expect(r.avatarId).toBe("mascot");
    expect(r.config).toEqual(deriveAvatarConfig(PERSONA));
  });

  it("re-rendering the same avatarId returns the SAME config (the first render wins)", async () => {
    const s = svc();
    const first = await s.render({ workspaceId: WID, persona: PERSONA });
    const again = await s.render({ workspaceId: WID, persona: { ...PERSONA, displayName: "Renamed" } });
    expect(again.config).toEqual(first.config);
    // display name also comes from the stored first render
    expect(again.displayName).toBe(first.displayName);
    expect(await s.list(WID)).toHaveLength(1);
  });

  it("pins a non-deterministic live provider after its first render", async () => {
    const s = svc({ provider: new DriftingProvider() });
    const first = await s.render({ workspaceId: WID, persona: PERSONA });
    expect(first.provider).toBe("drift");
    const again = await s.render({ workspaceId: WID, persona: PERSONA });
    expect(again.config).toEqual(first.config);
  });

  it("trims the avatarId so padded ids resolve to one stored avatar", async () => {
    const s = svc();
    await s.render({ workspaceId: WID, persona: { avatarId: "  pad  ", displayName: "Pad" } });
    const got = await s.get(WID, "pad");
    expect(got).not.toBeNull();
    expect(await s.list(WID)).toHaveLength(1);
  });
});

describe("provider fallback", () => {
  it("falls back to deterministic derivation when the provider returns null", async () => {
    const s = svc({ provider: new NullAvatarProvider() });
    const r = await s.render({ workspaceId: WID, persona: PERSONA });
    expect(r.provider).toBe("fake");
    expect(r.config).toEqual(deriveAvatarConfig(PERSONA));
  });

  it("falls back to deterministic derivation when the provider throws", async () => {
    const s = svc({ provider: new ThrowingProvider() });
    const r = await s.render({ workspaceId: WID, persona: PERSONA });
    expect(r.provider).toBe("fake");
    expect(r.config).toEqual(deriveAvatarConfig(PERSONA));
  });
});

describe("missing avatar", () => {
  it("get() returns null for an avatar that was never rendered", async () => {
    const s = svc();
    expect(await s.get(WID, "never-made")).toBeNull();
  });

  it("render() refuses a blank avatarId", async () => {
    const s = svc();
    await expect(
      s.render({ workspaceId: WID, persona: { avatarId: "   ", displayName: "x" } }),
    ).rejects.toThrow(/avatarId is required/);
  });
});

describe("workspace (IDOR) scoping", () => {
  it("never leaks one workspace's avatars to another", async () => {
    const store = new InMemoryAvatarStudioStore();
    const a = new AvatarStudioService({ store, caps: ENABLED, now: () => new Date(0) });
    await a.render({ workspaceId: WID, persona: PERSONA });
    expect(await a.get(OTHER_WID, "mascot")).toBeNull();
    expect(await a.list(OTHER_WID)).toEqual([]);
    expect(await a.list(WID)).toHaveLength(1);
  });

  it("the same avatarId in two workspaces renders independently", async () => {
    const store = new InMemoryAvatarStudioStore();
    const s = new AvatarStudioService({ store, caps: ENABLED, now: () => new Date(0) });
    const one = await s.render({ workspaceId: WID, persona: PERSONA });
    const two = await s.render({ workspaceId: OTHER_WID, persona: PERSONA });
    // deterministic ⇒ same config, but two distinct stored rows
    expect(two.config).toEqual(one.config);
    expect(await s.list(WID)).toHaveLength(1);
    expect(await s.list(OTHER_WID)).toHaveLength(1);
  });
});
