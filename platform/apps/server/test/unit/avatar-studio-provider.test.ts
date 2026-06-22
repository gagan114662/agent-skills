/**
 * Unit tests for the avatar render provider seam (#741): the deterministic FakeAvatarProvider produces stable,
 * consistent output with no external call; the NullAvatarProvider models a provider that cannot render; and a
 * custom throwing provider models a flaky live API — both exercised by the service's fallback in the service test.
 */

import { describe, it, expect } from "vitest";
import { FakeAvatarProvider, NullAvatarProvider } from "../../src/avatar-studio/provider.js";
import { deriveAvatarConfig } from "../../src/avatar-studio/render.js";
import type { AvatarPersona } from "../../src/avatar-studio/types.js";

const PERSONA: AvatarPersona = { avatarId: "spokesavatar-1", displayName: "Spokes" };

describe("FakeAvatarProvider", () => {
  it("is offline (live = false) and names itself 'fake'", () => {
    const p = new FakeAvatarProvider();
    expect(p.live).toBe(false);
    expect(p.name).toBe("fake");
  });

  it("renders the same config as the pure derivation (persona consistency through the seam)", async () => {
    const p = new FakeAvatarProvider();
    const first = await p.render(PERSONA);
    const second = await p.render(PERSONA);
    expect(first).toEqual(second);
    expect(first).toEqual(deriveAvatarConfig(PERSONA));
  });
});

describe("NullAvatarProvider", () => {
  it("is a live-shaped provider that never produces a config (forces fallback)", async () => {
    const p = new NullAvatarProvider();
    expect(p.live).toBe(true);
    expect(await p.render()).toBeNull();
  });
});
