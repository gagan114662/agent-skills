import type { ScoutResearchArtifact, TeamArtifact, TeamEvent, TeamEventKind } from "@reload/shared";

/**
 * Team channel wire codec (Team Mode). A {@link TeamEvent} is carried as a channel message body
 * tagged with a marker prefix + JSON, so the same format is produced server-side and parsed back
 * out of the channel — and an agent harness can emit one by simply printing the marker line.
 *
 * Lives in the server (not `@reload/shared`) because that package is consumed unbuilt and is kept
 * strictly type-only; the cross-cutting `TeamEvent` *type* still lives in shared.
 */

/** Marker prefix that tags a channel message body as an encoded team event. */
export const TEAM_EVENT_MARKER = "::team-event::";

const TEAM_EVENT_KINDS: readonly TeamEventKind[] = [
  "started",
  "milestone",
  "blocked",
  "needs_handoff",
  "done",
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseScoutResearchArtifact(input: Record<string, unknown>): ScoutResearchArtifact | null {
  if (
    input.kind !== "scout_research" ||
    input.schemaVersion !== 1 ||
    typeof input.siteSummary !== "string" ||
    typeof input.icp !== "string" ||
    typeof input.positioning !== "string" ||
    !isStringArray(input.proofPoints) ||
    !isStringArray(input.competitors) ||
    typeof input.toneNotes !== "string" ||
    !isStringArray(input.sourceUrls)
  ) {
    return null;
  }
  return {
    kind: "scout_research",
    schemaVersion: 1,
    siteSummary: input.siteSummary,
    icp: input.icp,
    positioning: input.positioning,
    proofPoints: input.proofPoints,
    competitors: input.competitors,
    toneNotes: input.toneNotes,
    sourceUrls: input.sourceUrls,
  };
}

function parseArtifact(input: unknown): TeamArtifact | null {
  if (input == null) return null;
  if (typeof input !== "object") return null;
  const artifact = input as Record<string, unknown>;
  if (artifact.kind === "scout_research") return parseScoutResearchArtifact(artifact);
  return null;
}

/** Encode a team event into a channel message body: `<marker> <json>`. */
export function encodeTeamEvent(event: TeamEvent): string {
  return `${TEAM_EVENT_MARKER} ${JSON.stringify(event)}`;
}

/**
 * Parse a channel message body back into a {@link TeamEvent}, or return `null` for anything that is
 * not a well-formed team event. Total (never throws) and strict about `kind`, so a channel full of
 * ordinary chatter parses cleanly — only real team events come back.
 */
export function tryParseTeamEvent(body: string): TeamEvent | null {
  if (!body.startsWith(TEAM_EVENT_MARKER)) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(TEAM_EVENT_MARKER.length).trim());
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const e = data as Record<string, unknown>;
  if (
    typeof e.teamRunId !== "string" ||
    typeof e.subtaskId !== "string" ||
    typeof e.agentMemberId !== "string" ||
    typeof e.summary !== "string" ||
    typeof e.createdAt !== "string" ||
    !(typeof e.branch === "string" || e.branch === null) ||
    typeof e.kind !== "string" ||
    !TEAM_EVENT_KINDS.includes(e.kind as TeamEventKind)
  ) {
    return null;
  }
  const artifact = e.artifact === undefined || e.artifact === null ? null : parseArtifact(e.artifact);
  if (e.artifact !== undefined && e.artifact !== null && !artifact) return null;
  return {
    teamRunId: e.teamRunId,
    subtaskId: e.subtaskId,
    agentMemberId: e.agentMemberId,
    kind: e.kind as TeamEventKind,
    summary: e.summary,
    branch: e.branch as string | null,
    ...(artifact ? { artifact } : {}),
    createdAt: e.createdAt,
  };
}
