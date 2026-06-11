import { describe, it, expect } from "vitest";
import { resolveVoiceCaps, VOICE_DEFAULTS } from "../../src/voice/caps.js";

describe("voice/caps — resolveVoiceCaps (#114): default OFF", () => {
  it("an unset config resolves to the default-OFF caps", () => {
    expect(resolveVoiceCaps(undefined)).toEqual(VOICE_DEFAULTS);
    expect(VOICE_DEFAULTS.enabled).toBe(false);
    expect(VOICE_DEFAULTS.autoTriageDraft).toBe(false);
  });

  it("explicit config overrides the defaults", () => {
    const caps = resolveVoiceCaps({ enabled: true, digestWindowDays: 14, autoTriageDraft: true });
    expect(caps.enabled).toBe(true);
    expect(caps.digestWindowDays).toBe(14);
    expect(caps.autoTriageDraft).toBe(true);
  });
});
