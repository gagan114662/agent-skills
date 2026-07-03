/**
 * Team-chain integration fixture harness (the "claude spawn" stand-in).
 *
 * A real Team Mode lane is a Claude CLI process that reads the coordinator's injected prompt
 * (`AGENT_TASK`), does its research (WebFetch), and emits a structured `::team-event::` artifact line
 * that the SessionManager posts into the channel — where the coordinator registers it so dependent
 * lanes can start. We cannot spawn Claude or hit the network in CI, so this fixture plays that exact
 * contract deterministically: it reads the SAME injected prompt, extracts the envelope ids the
 * coordinator wrote into it, and prints SCHEMA-VALID artifact events (validated by src/team/protocol.ts)
 * for whichever kinds this lane's production contract asks for. It fabricates nothing the validators
 * would reject, and every id it emits is the coordinator's own — so the run is a real end-to-end walk
 * of brief -> spawn -> research -> artifact registered -> dependents start, not a mock of it.
 *
 * Modes:
 *   - default: emit structured artifacts for the produced kinds (the happy path).
 *   - free-text scout (task contains FREE_TEXT_SCOUT_SENTINEL): the scout lane finishes its work but
 *     prints ONLY narrative output and emits NO structured event — exercising the #1536 recovery path
 *     where the coordinator recovers scout_research/brand_voice from the lane's work product.
 */

export const FREE_TEXT_SCOUT_SENTINEL = "::free-text-scout-mode::";

const SOURCE_URL = "https://example.com/about";

/** Pull a string field out of the coordinator's injected team-event envelope. */
function envelopeId(task, field) {
  const match = new RegExp('"' + field + '":\\s*"([^"]+)"').exec(task);
  return match ? match[1] : null;
}

/** Does this lane's production contract ask for this artifact kind? */
function produces(task, kind) {
  return new RegExp("(^|\\n)- " + kind + ":").test(task);
}

function emit(ids, artifact, summary) {
  const event = {
    teamRunId: ids.teamRunId,
    subtaskId: ids.subtaskId,
    agentMemberId: ids.agentMemberId,
    kind: "milestone",
    summary,
    branch: ids.branch,
    createdAt: new Date().toISOString(),
    artifact,
  };
  // Single-line marker + JSON: exactly what tryParseTeamEvent() parses back out of the channel.
  console.log("::team-event:: " + JSON.stringify(event));
}

function scoutResearch() {
  return {
    kind: "scout_research",
    schemaVersion: 1,
    siteSummary: "Example makes a self-serve analytics tool for small SaaS teams.",
    icp: "Solo founders and 2-10 person SaaS teams without a data analyst.",
    positioning: "The analytics you actually read: one weekly digest, no dashboards to babysit.",
    proofPoints: ["Used by 1,200 teams", "Set up in under 5 minutes"],
    competitors: ["Mixpanel", "Amplitude"],
    toneNotes: "Plain, concrete, a little dry. No hype words.",
    sourceUrls: [SOURCE_URL],
  };
}

function brandVoice() {
  return {
    kind: "brand_voice",
    schemaVersion: 1,
    profile: {
      toneAxes: ["plain over hype", "concrete over abstract"],
      vocabularyDo: ["ship", "weekly digest", "in minutes"],
      vocabularyDont: ["synergy", "revolutionary", "game-changing"],
      sentenceRhythm: "Short, declarative sentences. One idea each.",
      exampleLines: ["The analytics you actually read."],
    },
    sourceUrls: [SOURCE_URL],
  };
}

function draftSet() {
  return {
    kind: "draft_set",
    schemaVersion: 1,
    drafts: [
      {
        format: "linkedin_post",
        title: "Weekly digest launch",
        fields: {
          hook: "You do not need another dashboard you will never open.",
          body: "Example sends one weekly digest of what actually changed. Set up in under 5 minutes; 1,200 teams already read it.",
          cta: "See a sample digest",
        },
        citations: ["Used by 1,200 teams", SOURCE_URL],
      },
    ],
  };
}

function lensReview() {
  // All 5s -> average 5.0 >= threshold 4, so no revised draft is required by the validator.
  const scores = {
    specificityToBusiness: 5,
    hookStrength: 5,
    clarity: 5,
    evidenceUse: 5,
    ctaQuality: 5,
    voiceConsistency: 5,
  };
  return {
    kind: "lens_review",
    schemaVersion: 1,
    threshold: 4,
    summary: "Draft is specific, on-voice, and evidence-backed. Ready for owner review.",
    reviews: [
      {
        format: "linkedin_post",
        title: "Weekly digest launch",
        scores,
        averageScore: 5,
        revisionNote: "Optional: lead with the 5-minute setup for scanners.",
      },
    ],
  };
}

/** Run the lane: read the injected prompt, emit the artifacts its production contract asks for. */
function run() {
  const task = process.env.AGENT_TASK ?? "";
  const ids = {
    teamRunId: envelopeId(task, "teamRunId"),
    subtaskId: envelopeId(task, "subtaskId"),
    agentMemberId: envelopeId(task, "agentMemberId"),
    branch: envelopeId(task, "branch"),
  };
  const freeTextScout = task.includes(FREE_TEXT_SCOUT_SENTINEL);

  // Narrative output first (this is what becomes the lane's work product / result tail).
  console.log("agent: researched the site and market for this brief.");

  if (produces(task, "scout_research") && !freeTextScout) {
    emit(ids, scoutResearch(), "research artifact ready: example.com");
  }
  if (produces(task, "brand_voice") && !freeTextScout) {
    emit(ids, brandVoice(), "brand voice ready: example.com");
  }
  if (produces(task, "scout_research") && freeTextScout) {
    // #1536 recovery path: do the work, describe it, but never emit the structured envelope.
    console.log(
      "Site summary: Example makes self-serve analytics for small SaaS teams. ICP: solo founders and " +
        "small teams. Positioning: the analytics you actually read. Tone: plain, concrete, no hype.",
    );
  }
  if (produces(task, "draft_set")) {
    emit(ids, draftSet(), "draft set ready: example.com");
  }
  if (produces(task, "lens_review")) {
    emit(ids, lensReview(), "lens review ready: example.com");
  }

  console.log("agent: done");
}

// Only run when spawned as the harness entrypoint — importing this module (for the sentinel) is
// side-effect free.
if (process.argv[1] && process.argv[1].endsWith("team-chain-harness.mjs")) {
  run();
}
