import { describe, it, expect } from "vitest";
import {
  SIGNUP_ENTRY_DEFAULTS,
  resolveSignupEntryCaps,
  isSampleWorkspaceOffered,
  isProgressiveScopesEnabled,
  buildSampleConsole,
} from "../../src/onboarding/signup-entry.js";

describe("signup-entry caps (#300 — low-commitment front door, default OFF)", () => {
  it("defaults both flags OFF (today's #260 Google-only behavior)", () => {
    expect(SIGNUP_ENTRY_DEFAULTS).toEqual({ sampleWorkspace: false, progressiveScopes: false });
    expect(resolveSignupEntryCaps(undefined)).toEqual(SIGNUP_ENTRY_DEFAULTS);
    expect(resolveSignupEntryCaps({})).toEqual(SIGNUP_ENTRY_DEFAULTS);
    expect(isSampleWorkspaceOffered(resolveSignupEntryCaps(undefined))).toBe(false);
    expect(isProgressiveScopesEnabled(resolveSignupEntryCaps(undefined))).toBe(false);
  });

  it("honors explicitly-enabled flags", () => {
    const caps = resolveSignupEntryCaps({ sampleWorkspace: true, progressiveScopes: true });
    expect(caps).toEqual({ sampleWorkspace: true, progressiveScopes: true });
    expect(isSampleWorkspaceOffered(caps)).toBe(true);
    expect(isProgressiveScopesEnabled(caps)).toBe(true);
  });

  it("each flag is independent (sample on, progressive off)", () => {
    const caps = resolveSignupEntryCaps({ sampleWorkspace: true });
    expect(caps).toEqual({ sampleWorkspace: true, progressiveScopes: false });
  });
});

describe("buildSampleConsole (#300 — read-only demo with a real deliverable)", () => {
  const sample = buildSampleConsole();

  it("is flagged read-only so it can never be mistaken for a real tenant", () => {
    expect(sample.readOnly).toBe(true);
    expect(sample.workspaceLabel.length).toBeGreaterThan(0);
  });

  it("surfaces at least one real agent deliverable (AC: see a deliverable without any Google scope)", () => {
    expect(sample.deliverables.length).toBeGreaterThanOrEqual(1);
    const first = sample.deliverables[0]!;
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.agent.length).toBeGreaterThan(0);
    expect(first.department.length).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.preview.length).toBeGreaterThan(0);
    // A substantive body, not a stub — this is a representative Scout SEO deliverable.
    expect(first.body.length).toBeGreaterThan(200);
  });

  it("every deliverable has a stable, unique id (so the UI can key cards)", () => {
    const ids = sample.deliverables.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic + carries no untrusted input (#200 §6 — static by construction)", () => {
    expect(buildSampleConsole()).toEqual(buildSampleConsole());
  });
});
