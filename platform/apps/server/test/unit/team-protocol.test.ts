import { describe, it, expect } from "vitest";
import type { TeamEvent } from "@reload/shared";
import {
  encodeTeamEvent,
  tryParseTeamEvent,
  TEAM_EVENT_MARKER,
} from "../../src/team/protocol.js";

const sample = (over: Partial<TeamEvent> = {}): TeamEvent => ({
  teamRunId: "run_1",
  subtaskId: "sub_1",
  agentMemberId: "mem_agent",
  kind: "milestone",
  summary: "wrote the parser",
  branch: "feat/parser",
  createdAt: "2026-06-08T00:00:00.000Z",
  ...over,
});

const strongScores = {
  specificityToBusiness: 5,
  hookStrength: 4,
  clarity: 5,
  evidenceUse: 4,
  ctaQuality: 4,
  voiceConsistency: 5,
};

describe("team channel protocol (encode / tryParse)", () => {
  it("round-trips every event kind through encode → parse", () => {
    for (const kind of ["started", "milestone", "blocked", "needs_handoff", "done"] as const) {
      const event = sample({ kind });
      const decoded = tryParseTeamEvent(encodeTeamEvent(event));
      expect(decoded).toEqual(event);
    }
  });

  it("preserves a null branch (before one is assigned)", () => {
    const event = sample({ branch: null });
    expect(tryParseTeamEvent(encodeTeamEvent(event))).toEqual(event);
  });

  it("round-trips a typed Scout research artifact (#1540)", () => {
    const event = sample({
      artifact: {
        kind: "scout_research",
        schemaVersion: 1,
        siteSummary: "Acme sells compliance workflow software.",
        icp: "RevOps leaders at regulated B2B teams",
        positioning: "A clean audit trail without spreadsheet wrangling.",
        proofPoints: ["SOC2 page mentions audit exports", "Pricing page names RevOps"],
        competitors: ["spreadsheet process", "legacy GRC suite"],
        toneNotes: "Plain, direct, low-drama.",
        sourceUrls: ["https://acme.test"],
      },
    });

    expect(tryParseTeamEvent(encodeTeamEvent(event))).toEqual(event);
  });

  it("rejects malformed Scout research artifacts", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({
      ...sample(),
      artifact: {
        kind: "scout_research",
        schemaVersion: 1,
        siteSummary: "missing arrays",
      },
    })}`;

    expect(tryParseTeamEvent(body)).toBeNull();
  });

  it("round-trips a validated channel-native draft set (#1541)", () => {
    const event = sample({
      artifact: {
        kind: "draft_set",
        schemaVersion: 1,
        drafts: [
          {
            format: "google_rsa",
            title: "Search ads",
            fields: {
              headlines: Array.from({ length: 15 }, (_, i) => "Proof headline " + (i + 1)),
              descriptions: Array.from({ length: 4 }, (_, i) => "Specific proof-led description " + (i + 1)),
            },
            citations: ["Homepage says marketing team in your messages"],
          },
          {
            format: "meta_ad",
            title: "Founder ad",
            fields: { hook: "Your marketing room is already awake.", body: "Brief Scout and Quill from chat.", cta: "Start", headline: "Marketing in messages", description: "Drafts await approval" },
            citations: ["https://ipop.ai"],
          },
          {
            format: "linkedin_post",
            title: "LinkedIn launch",
            fields: { hook: "Most AI marketing tools still make you manage the work.", body: "ipop makes the team visible in the room.", cta: "Reply for the checklist" },
            citations: ["Scout found founder ICP"],
          },
          {
            format: "x_thread",
            title: "X thread",
            fields: { tweets: ["Your marketing team should show its work.", "Scout researches, Quill drafts, and you approve before anything ships."] },
            citations: ["Room names Scout and Quill"],
          },
          {
            format: "email",
            title: "Welcome email",
            fields: { subject: "Your marketing room is ready", preheader: "Scout found the first useful move.", body: "Here is the first draft for review.", cta: "Review the draft", plainTextAlt: "Review the first draft in ipop." },
            citations: ["source URL cited"],
          },
          {
            format: "landing_hero",
            title: "Homepage hero",
            fields: { headline: "Marketing work, visible in messages", subhead: "Scout researches, Quill drafts, and every send waits for your approval.", cta: "Start the room" },
            citations: ["siteSummary says messaging-native"],
          },
          {
            format: "seo_snippet",
            title: "SEO snippet",
            fields: { title: "AI marketing team in your messages", metaDescription: "AI teammates research your site, draft channel-ready marketing work, and keep every send or spend behind approval while you watch progress in messages.", intent: "brand-aware marketing team software" },
            citations: ["siteSummary says marketing team"],
          },
        ],
      },
    });

    expect(tryParseTeamEvent(encodeTeamEvent(event))).toEqual(event);
  });

  it("surfaces draft set validator failures as blocked timeline events (#1541)", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({
      ...sample(),
      artifact: {
        kind: "draft_set",
        schemaVersion: 1,
        drafts: [
          {
            format: "google_rsa",
            title: "Bad search ads",
            fields: { headlines: ["one headline only"], descriptions: ["one description only"] },
            citations: ["https://ipop.ai"],
          },
        ],
      },
    })}`;

    expect(tryParseTeamEvent(body)).toMatchObject({
      kind: "blocked",
      summary: "blocked: invalid draft_set artifact: google_rsa.headlines: must include exactly 15 headlines",
    });
  });

  it("round-trips a Lens rubric review artifact (#1542)", () => {
    const event = sample({
      artifact: {
        kind: "lens_review",
        schemaVersion: 1,
        threshold: 4,
        summary: "The email is specific, proof-led, and ready for owner review.",
        reviews: [
          {
            format: "email",
            title: "Welcome email",
            scores: strongScores,
            averageScore: 4.5,
            revisionNote: "Tighten the CTA around the room review moment.",
          },
        ],
      },
    });

    expect(tryParseTeamEvent(encodeTeamEvent(event))).toEqual(event);
  });

  it("requires one revised draft when a Lens score falls below threshold (#1542)", () => {
    const lowScores = {
      specificityToBusiness: 3,
      hookStrength: 3,
      clarity: 3,
      evidenceUse: 3,
      ctaQuality: 3,
      voiceConsistency: 3,
    };
    const body = TEAM_EVENT_MARKER + " " + JSON.stringify({
      ...sample(),
      artifact: {
        kind: "lens_review",
        schemaVersion: 1,
        threshold: 4,
        summary: "The email needs one proof-led revision before owner review.",
        reviews: [
          {
            format: "email",
            title: "Welcome email",
            scores: lowScores,
            averageScore: 3,
            revisionNote: "Replace generic language with the observed room workflow.",
          },
        ],
      },
    });

    expect(tryParseTeamEvent(body)).toMatchObject({
      kind: "blocked",
      summary: "blocked: invalid lens_review artifact: email.revisedDraft: required when averageScore is below threshold",
    });
  });

  it("tags the body with the marker prefix", () => {
    expect(encodeTeamEvent(sample())).toMatch(new RegExp(`^${TEAM_EVENT_MARKER} `));
  });

  it("returns null for ordinary chatter (not a team event)", () => {
    expect(tryParseTeamEvent("hello team, how's it going?")).toBeNull();
    expect(tryParseTeamEvent("")).toBeNull();
  });

  it("returns null for a marker with malformed JSON", () => {
    expect(tryParseTeamEvent(`${TEAM_EVENT_MARKER} {not json`)).toBeNull();
  });

  it("rejects an unknown kind", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({ ...sample(), kind: "exploded" })}`;
    expect(tryParseTeamEvent(body)).toBeNull();
  });

  it("rejects an event missing required fields", () => {
    const body = `${TEAM_EVENT_MARKER} ${JSON.stringify({ teamRunId: "r", kind: "done" })}`;
    expect(tryParseTeamEvent(body)).toBeNull();
  });
});
