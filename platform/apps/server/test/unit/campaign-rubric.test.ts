import { describe, expect, it } from "vitest";
import {
  AWARD_BAR,
  DEMO_CAMPAIGN_ASSETS,
  IPOP_LAUNCH_BRIEF,
  REQUIRED_ASSETS,
  SPEC,
  deriveGapDrafts,
  detectSlop,
  detectUnapprovedClaims,
  renderScoredCampaign,
  scoreAsset,
  scoreCampaign,
  validateAsset,
  type CampaignAsset,
} from "../../src/campaign-rubric/index.js";

const ctx = { approvedClaims: IPOP_LAUNCH_BRIEF.brandClaims };

describe("campaign-rubric spec validators", () => {
  it("flags a Google RSA headline over 30 chars as a spec error", () => {
    const ad: CampaignAsset = {
      kind: "google-search-ad",
      title: "ad",
      lists: {
        headlines: ["Short One", "Marketing That Actually Ships Every Single Week", "Third Headline Here", "Fourth", "Fifth"],
        descriptions: ["A description well under ninety characters that fits fine.", "Another compliant description line here."],
      },
    };
    const violations = validateAsset(ad);
    const lengthError = violations.find((v) => v.rule === "google.headline.length" && v.severity === "error");
    expect(lengthError).toBeDefined();
    expect(lengthError?.message).toContain(String("Marketing That Actually Ships Every Single Week".length));
  });

  it("passes a spec-clean Google RSA", () => {
    const ad: CampaignAsset = {
      kind: "google-search-ad",
      title: "ad",
      lists: {
        headlines: ["AI Marketing Department", "One Brief One Campaign", "You Approve Every Send", "Ships Real Assets", "For Small Teams"],
        descriptions: ["Write one brief. Agents plan, write, and ship. You approve anything public.", "Real campaigns, not demos, gated by a human."],
      },
    };
    expect(validateAsset(ad).some((v) => v.severity === "error")).toBe(false);
  });

  it("requires a shot list on a video script and an X post under 280", () => {
    const noShots: CampaignAsset = { kind: "video-script", title: "v", text: "Some narration that is long enough to be a spot but has no shots listed at all here." };
    expect(validateAsset(noShots).some((v) => v.rule === "video.shots")).toBe(true);
    const longX: CampaignAsset = { kind: "social-x", title: "x", text: "a".repeat(SPEC.socialX.max + 1) };
    expect(validateAsset(longX).some((v) => v.rule === "social.x.length" && v.severity === "error")).toBe(true);
  });
});

describe("campaign-rubric voice checks", () => {
  it("detects AI-slop phrases", () => {
    const a: CampaignAsset = { kind: "meta-ad", title: "m", fields: { primaryText: "We seamlessly revolutionize your funnel.", headline: "h", visual: "v" } };
    const hits = detectSlop(a);
    expect(hits.map((h) => h.phrase)).toEqual(expect.arrayContaining(["seamlessly", "revolutionize"]));
  });

  it("flags an unapproved numeric claim not on the allowlist", () => {
    const a: CampaignAsset = { kind: "social-x", title: "x", text: "It drafted everything 10x faster than hiring a team." };
    const claims = detectUnapprovedClaims(a, IPOP_LAUNCH_BRIEF.brandClaims);
    expect(claims.length).toBeGreaterThan(0);
  });

  it("does not flag a claim that IS on the allowlist", () => {
    const a: CampaignAsset = { kind: "social-x", title: "x", text: "A human approves every send and spend before it goes out." };
    expect(detectUnapprovedClaims(a, IPOP_LAUNCH_BRIEF.brandClaims)).toHaveLength(0);
  });
});

describe("scoreAsset", () => {
  it("never certifies an ungraded asset, even when objectively clean", () => {
    const a: CampaignAsset = { kind: "landing-hero", title: "hero", fields: { headline: "Your marketing, as agents", subhead: "Write one brief.", cta: "Start" } };
    const scored = scoreAsset(a, ctx);
    expect(scored.graded).toBe(false);
    expect(scored.passesBar).toBe(false);
    expect(scored.rewriteNotes.some((n) => n.includes("Lens"))).toBe(true);
  });

  it("caps a generous craft grade by the objective craft floor (spec-invalid can't be rescued)", () => {
    const a: CampaignAsset = { kind: "landing-hero", title: "hero", fields: { subhead: "no headline, no cta" } };
    const scored = scoreAsset(a, ctx, { insight: 9, craft: 10, channelNativeness: 9, coherence: 9 });
    // hero with no headline + no cta = 2 spec errors → craft objective = 10 - 7 = 3, so craft capped at 3.
    expect(scored.scores.craft).toBeLessThanOrEqual(3);
    expect(scored.passesBar).toBe(false);
  });

  it("certifies a graded, clean, in-spec asset at the bar", () => {
    const a: CampaignAsset = { kind: "landing-hero", title: "hero", fields: { headline: "Your marketing, as agents", subhead: "Write one brief; agents ship it.", cta: "Start" } };
    const scored = scoreAsset(a, ctx, { insight: 8, craft: 9, channelNativeness: 9, coherence: 9 });
    expect(scored.graded).toBe(true);
    expect(scored.scores.overall).toBeGreaterThanOrEqual(AWARD_BAR);
    expect(scored.passesBar).toBe(true);
  });
});

describe("scoreCampaign on the ipop-launches-itself demo", () => {
  const scored = scoreCampaign(IPOP_LAUNCH_BRIEF, DEMO_CAMPAIGN_ASSETS);

  it("has complete coverage (all required kinds, 5 emails)", () => {
    expect(scored.coverageGaps).toHaveLength(0);
    expect(DEMO_CAMPAIGN_ASSETS.filter((a) => a.kind === "email")).toHaveLength(5);
  });

  it("catches the seeded spec error, slop, and unapproved claim", () => {
    const specInvalid = scored.assets.filter((a) => a.specViolations.some((v) => v.severity === "error"));
    expect(specInvalid.some((a) => a.kind === "google-search-ad")).toBe(true);
    expect(scored.assets.some((a) => a.slopHits.length > 0)).toBe(true);
    expect(scored.assets.some((a) => a.claimViolations.length > 0)).toBe(true);
  });

  it("is below-bar and un-graded, with named blockers", () => {
    expect(scored.verdict).toBe("below-bar");
    expect(scored.fullyGraded).toBe(false);
    expect(scored.blockers.some((b) => b.includes("ungraded"))).toBe(true);
    expect(scored.blockers.some((b) => b.includes("Spec-invalid"))).toBe(true);
  });

  it("renders a scored artifact and derives dedup'd gap drafts", () => {
    const md = renderScoredCampaign(scored, { runId: "test-run", provenance: "demonstration (hand-authored)" });
    expect(md).toContain("Verdict: BELOW-BAR");
    expect(md).toContain("| Asset | Kind |");
    const drafts = deriveGapDrafts(scored, "test-run");
    expect(drafts.length).toBeGreaterThan(0);
    const fingerprints = drafts.map((d) => d.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length); // no duplicate fingerprints
  });

  it("only files per-asset below-bar gaps for concrete defects, not every ungraded asset", () => {
    const drafts = deriveGapDrafts(scored, "test-run");
    // The demo has ONE spec-invalid asset (google ad), ONE slop asset (meta), ONE claim asset (X).
    // The clean-but-ungraded assets (e.g. landing-hero) must NOT each spawn a below-bar gap.
    expect(drafts.some((d) => d.title.includes("landing-hero below award bar"))).toBe(false);
    expect(drafts.some((d) => d.title.includes("meta-ad below award bar"))).toBe(true);
    expect(drafts.some((d) => d.title.includes("social-x below award bar"))).toBe(true);
    // Total campaign-level drafts stay small (no 15× ungraded spam).
    expect(drafts.length).toBeLessThanOrEqual(5);
  });

  it("reports a coverage gap when the email sequence is short", () => {
    const short = DEMO_CAMPAIGN_ASSETS.filter((a) => a.kind !== "email").concat(DEMO_CAMPAIGN_ASSETS.filter((a) => a.kind === "email").slice(0, 2));
    const s = scoreCampaign(IPOP_LAUNCH_BRIEF, short);
    const emailGap = s.coverageGaps.find((g) => g.kind === "email");
    expect(emailGap).toEqual({ kind: "email", required: 5, present: 2 });
    expect(s.verdict).toBe("incomplete");
  });

  it("is deterministic", () => {
    const again = scoreCampaign(IPOP_LAUNCH_BRIEF, DEMO_CAMPAIGN_ASSETS);
    expect(again.overall).toBe(scored.overall);
    expect(again.assets.map((a) => a.scores.overall)).toEqual(scored.assets.map((a) => a.scores.overall));
  });

  it("REQUIRED_ASSETS lists all eleven mandated kinds", () => {
    expect(REQUIRED_ASSETS.map((r) => r.kind)).toEqual(
      expect.arrayContaining([
        "blog", "landing-hero", "google-search-ad", "meta-ad", "email",
        "social-x", "social-linkedin", "social-instagram", "social-tiktok", "video-script", "ooh-print",
      ]),
    );
  });
});
