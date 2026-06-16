import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENT_MODEL,
  KNOWN_AGENT_MODELS,
  knownModels,
  isKnownModel,
  effectiveModel,
  resolveLaunchModel,
  assertModelLaunchable,
  ModelUnavailableError,
} from "../../src/runtime/models.js";

describe("model registry (#246 — fleet model = claude-opus-4-8, no unservable id ships)", () => {
  it("the canonical default is claude-opus-4-8 and is itself known", () => {
    expect(DEFAULT_AGENT_MODEL).toBe("claude-opus-4-8");
    expect(isKnownModel(DEFAULT_AGENT_MODEL, {})).toBe(true);
    expect(KNOWN_AGENT_MODELS).toContain("claude-opus-4-8");
  });

  it("rejects the live-confirmed unservable id (claude-fable-5)", () => {
    expect(isKnownModel("claude-fable-5", {})).toBe(false);
    expect(() => assertModelLaunchable("claude-fable-5", {})).toThrow(ModelUnavailableError);
    // The error names the model (a non-secret owner config value) so the message is actionable.
    try {
      assertModelLaunchable("claude-fable-5", {});
    } catch (e) {
      expect((e as ModelUnavailableError).model).toBe("claude-fable-5");
      expect((e as Error).message).toContain("claude-fable-5");
      expect((e as Error).message.toLowerCase()).toContain("pick a valid model");
    }
  });

  it("rejects blank / shell-hostile ids", () => {
    expect(() => assertModelLaunchable("", {})).toThrow(ModelUnavailableError);
    expect(() => assertModelLaunchable("   ", {})).toThrow(ModelUnavailableError);
    expect(() => assertModelLaunchable("claude; rm -rf /", {})).toThrow(ModelUnavailableError);
  });

  it("RELOAD_KNOWN_MODELS is an escape hatch so a new valid model isn't a hard blocker", () => {
    const env = { RELOAD_KNOWN_MODELS: "claude-future-9, claude-other-1" };
    expect(isKnownModel("claude-future-9", env)).toBe(true);
    expect(() => assertModelLaunchable("claude-future-9", env)).not.toThrow();
    expect(knownModels(env)).toContain("claude-other-1");
    // A garbage entry in the escape hatch is ignored (charset-validated), not blindly trusted.
    expect(isKnownModel("claude-future-9", {})).toBe(false);
  });

  it("effectiveModel applies precedence: session pin > workspace pick > env default > canonical", () => {
    expect(
      effectiveModel({ sessionPinned: "claude-haiku-4-5", workspacePicked: "claude-sonnet-4-6", envDefault: "claude-opus-4-8" }),
    ).toBe("claude-haiku-4-5");
    expect(effectiveModel({ workspacePicked: "claude-sonnet-4-6", envDefault: "claude-opus-4-8" })).toBe(
      "claude-sonnet-4-6",
    );
    expect(effectiveModel({ envDefault: "claude-opus-4-8" })).toBe("claude-opus-4-8");
    expect(effectiveModel({})).toBe(DEFAULT_AGENT_MODEL);
    // blank values never win over a real lower-precedence default
    expect(effectiveModel({ sessionPinned: "  ", workspacePicked: "", envDefault: "claude-sonnet-4-6" })).toBe(
      "claude-sonnet-4-6",
    );
  });

  describe("resolveLaunchModel — the runtime boundary always yields a launchable model (managed default)", () => {
    it("empty / null / whitespace at every level resolves to the managed default — the fleet is never disabled", () => {
      expect(resolveLaunchModel({}, {})).toBe(DEFAULT_AGENT_MODEL);
      expect(resolveLaunchModel({ sessionPinned: null, workspacePicked: null, envDefault: null }, {})).toBe(
        DEFAULT_AGENT_MODEL,
      );
      // The exact reported bug: an empty "Default" pick must NOT pass an empty model through to the spawn.
      expect(resolveLaunchModel({ workspacePicked: "", envDefault: "" }, {})).toBe(DEFAULT_AGENT_MODEL);
      expect(resolveLaunchModel({ sessionPinned: "   ", workspacePicked: "  ", envDefault: " " }, {})).toBe(
        DEFAULT_AGENT_MODEL,
      );
    });

    it("an unknown / unservable id (claude-fable-5 class) resolves to the managed default instead of disabling the fleet", () => {
      // Unlike assertModelLaunchable (which throws — used only by the admin save path), the runtime
      // boundary must self-heal: a bad value falls through to the managed default, never a mid-run crash.
      expect(resolveLaunchModel({ workspacePicked: "claude-fable-5" }, {})).toBe(DEFAULT_AGENT_MODEL);
      expect(resolveLaunchModel({ envDefault: "claude-fable-5" }, {})).toBe(DEFAULT_AGENT_MODEL);
      // A shell-hostile id also falls through (never reaches the spawn).
      expect(resolveLaunchModel({ workspacePicked: "claude; rm -rf /" }, {})).toBe(DEFAULT_AGENT_MODEL);
    });

    it("honours a valid pick and applies precedence, skipping unknown higher-precedence candidates", () => {
      expect(resolveLaunchModel({ workspacePicked: "claude-sonnet-4-6" }, {})).toBe("claude-sonnet-4-6");
      expect(resolveLaunchModel({ sessionPinned: "claude-haiku-4-5", workspacePicked: "claude-sonnet-4-6" }, {})).toBe(
        "claude-haiku-4-5",
      );
      // An unknown session pin is skipped and the next valid candidate wins (never throws, never empty).
      expect(resolveLaunchModel({ sessionPinned: "claude-fable-5", workspacePicked: "claude-sonnet-4-6" }, {})).toBe(
        "claude-sonnet-4-6",
      );
    });

    it("respects the RELOAD_KNOWN_MODELS escape hatch when judging a candidate launchable", () => {
      expect(resolveLaunchModel({ workspacePicked: "claude-future-9" }, { RELOAD_KNOWN_MODELS: "claude-future-9" })).toBe(
        "claude-future-9",
      );
      // Without the escape hatch the same id is unknown → managed default.
      expect(resolveLaunchModel({ workspacePicked: "claude-future-9" }, {})).toBe(DEFAULT_AGENT_MODEL);
    });
  });
});
