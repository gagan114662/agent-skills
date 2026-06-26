import { describe, it, expect, vi } from "vitest";
import {
  bootstrapFirstRunReceipt,
  bootstrapAfterGoogleSignin,
  scoutVerifyGoal,
  type OnboardingBootstrapDeps,
} from "../../src/auth/onboarding-bootstrap.js";

function recordingDeps(overrides: Partial<OnboardingBootstrapDeps> = {}) {
  const calls: string[] = [];
  const deps: OnboardingBootstrapDeps = {
    setDomain: vi.fn(async () => void calls.push("setDomain")),
    seedFleet: vi.fn(async () => void calls.push("seedFleet")),
    briefScout: vi.fn(async () => void calls.push("briefScout")),
    recordFirstRunReceipt: vi.fn(async () => void calls.push("recordFirstRunReceipt")),
    markBootstrapped: vi.fn(async () => void calls.push("markBootstrapped")),
    log: { error: vi.fn() },
    ...overrides,
  };
  return { deps, calls };
}

const INPUT = {
  workspaceId: "ws1",
  memberId: "m1",
  domain: "acme.com",
  siteUrl: "https://acme.com",
};

describe("bootstrapAfterGoogleSignin (#260)", () => {
  it("persists the domain, seeds the fleet, briefs Scout, records first-run proof, then marks bootstrapped — in order", async () => {
    const { deps, calls } = recordingDeps();
    await bootstrapAfterGoogleSignin(deps, INPUT);
    expect(calls).toEqual([
      "setDomain",
      "seedFleet",
      "briefScout",
      "recordFirstRunReceipt",
      "markBootstrapped",
    ]);
    expect(deps.setDomain).toHaveBeenCalledWith("ws1", "acme.com");
    expect(deps.seedFleet).toHaveBeenCalledWith({ workspaceId: "ws1", memberId: "m1" });
  });

  it("briefs Scout with a verify-domain + submit-sitemap goal that names the site URL", async () => {
    const { deps } = recordingDeps();
    await bootstrapAfterGoogleSignin(deps, INPUT);
    const brief = (deps.briefScout as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      workspaceId: string;
      memberId: string;
      goal: string;
    };
    expect(brief.workspaceId).toBe("ws1");
    expect(brief.goal).toBe(scoutVerifyGoal("https://acme.com"));
    expect(brief.goal).toMatch(/Search Console/);
    expect(brief.goal).toMatch(/sitemap/);
    expect(brief.goal).toContain("https://acme.com");
  });

  it("records a first-run dashboard receipt for the queued Scout brief (#1289)", async () => {
    const { deps } = recordingDeps();
    await bootstrapAfterGoogleSignin(deps, INPUT);
    expect(deps.recordFirstRunReceipt).toHaveBeenCalledWith(bootstrapFirstRunReceipt(INPUT));
    expect(bootstrapFirstRunReceipt(INPUT).artifactSummary).toBe(
      scoutVerifyGoal("https://acme.com"),
    );
    expect(bootstrapFirstRunReceipt(INPUT).receipt).toContain("acme.com");
  });

  it("is best-effort: a seed failure still lets the brief + mark run (the user must reach the board)", async () => {
    const { deps, calls } = recordingDeps({
      seedFleet: vi.fn(async () => {
        throw new Error("seed boom");
      }),
    });
    await expect(bootstrapAfterGoogleSignin(deps, INPUT)).resolves.toBeUndefined();
    expect(calls).toEqual(["setDomain", "briefScout", "recordFirstRunReceipt", "markBootstrapped"]); // seedFleet threw, others ran
    expect(deps.log!.error).toHaveBeenCalled();
  });
});
