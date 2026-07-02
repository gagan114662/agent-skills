import type {
  DraftSetArtifact,
  MarketingDraft,
  MarketingDraftFormat,
  ScoutResearchArtifact,
  TeamArtifact,
  TeamEvent,
  TeamEventKind,
} from "@reload/shared";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MARKETING_DRAFT_FORMATS: readonly MarketingDraftFormat[] = [
  "google_rsa",
  "meta_ad",
  "linkedin_post",
  "x_thread",
  "email",
  "landing_hero",
  "seo_snippet",
];

function parseDraftFields(input: unknown): Record<string, string | string[]> | null {
  if (!isRecord(input)) return null;
  const fields: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || isStringArray(value)) fields[key] = value;
    else return null;
  }
  return fields;
}

function parseMarketingDraft(input: unknown): MarketingDraft | null {
  if (!isRecord(input)) return null;
  if (typeof input.format !== "string" || !MARKETING_DRAFT_FORMATS.includes(input.format as MarketingDraftFormat)) {
    return null;
  }
  if (typeof input.title !== "string" || !isStringArray(input.citations)) return null;
  const fields = parseDraftFields(input.fields);
  if (!fields) return null;
  return {
    format: input.format as MarketingDraftFormat,
    title: input.title,
    fields,
    citations: input.citations,
  };
}

const SPAM_TRIGGER_RE = /\b(?:free money|guaranteed|risk-free|act now|limited time|winner|cash bonus)\b/i;

function fieldText(draft: MarketingDraft, field: string): string {
  const value = draft.fields[field];
  return typeof value === "string" ? value : "";
}

function fieldList(draft: MarketingDraft, field: string): string[] {
  const value = draft.fields[field];
  return Array.isArray(value) ? value : [];
}

function hasText(draft: MarketingDraft, field: string): boolean {
  const value = draft.fields[field];
  return typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.some((item) => item.trim());
}

function maxText(draft: MarketingDraft, field: string, max: number): boolean {
  const value = fieldText(draft, field);
  return value.length <= max;
}

function draftIssue(draft: MarketingDraft, field: string, message: string): string {
  return draft.format + "." + field + ": " + message;
}

function validateMarketingDraft(draft: MarketingDraft): string[] {
  const issues: string[] = [];
  if (!draft.title.trim()) issues.push(draftIssue(draft, "title", "required"));
  if (draft.citations.length === 0) issues.push(draftIssue(draft, "citations", "must cite Scout proofPoints or sourceUrls"));
  if (draft.format === "google_rsa") {
    const headlines = fieldList(draft, "headlines");
    const descriptions = fieldList(draft, "descriptions");
    if (headlines.length !== 15) issues.push(draftIssue(draft, "headlines", "must include exactly 15 headlines"));
    if (descriptions.length !== 4) issues.push(draftIssue(draft, "descriptions", "must include exactly 4 descriptions"));
    headlines.forEach((headline, index) => {
      if (headline.length > 30) issues.push(draftIssue(draft, "headlines[" + index + "]", "must be 30 characters or fewer"));
    });
    descriptions.forEach((description, index) => {
      if (description.length > 90) issues.push(draftIssue(draft, "descriptions[" + index + "]", "must be 90 characters or fewer"));
    });
  }
  else if (draft.format === "meta_ad") {
    if (!hasText(draft, "hook")) issues.push(draftIssue(draft, "hook", "required"));
    if (!hasText(draft, "body")) issues.push(draftIssue(draft, "body", "required"));
    if (!hasText(draft, "cta")) issues.push(draftIssue(draft, "cta", "required"));
    if (!maxText(draft, "hook", 125)) issues.push(draftIssue(draft, "hook", "must be 125 characters or fewer"));
    if (!maxText(draft, "headline", 40)) issues.push(draftIssue(draft, "headline", "must be 40 characters or fewer"));
    if (!maxText(draft, "description", 30)) issues.push(draftIssue(draft, "description", "must be 30 characters or fewer"));
  }
  else if (draft.format === "linkedin_post") {
    if (!hasText(draft, "hook")) issues.push(draftIssue(draft, "hook", "required"));
    if (!hasText(draft, "body")) issues.push(draftIssue(draft, "body", "required"));
    if (!maxText(draft, "hook", 180)) issues.push(draftIssue(draft, "hook", "must be 180 characters or fewer"));
    if (!maxText(draft, "cta", 120)) issues.push(draftIssue(draft, "cta", "must be 120 characters or fewer"));
  }
  else if (draft.format === "x_thread") {
    const tweets = fieldList(draft, "tweets");
    if (tweets.length < 2 || tweets.length > 8) issues.push(draftIssue(draft, "tweets", "must include 2 to 8 tweets"));
    tweets.forEach((tweet, index) => {
      if (tweet.length > 280) issues.push(draftIssue(draft, "tweets[" + index + "]", "must be 280 characters or fewer"));
    });
  }
  else if (draft.format === "email") {
    const emailText = [fieldText(draft, "subject"), fieldText(draft, "preheader"), fieldText(draft, "body")].join(" ");
    if (!hasText(draft, "subject")) issues.push(draftIssue(draft, "subject", "required"));
    if (!hasText(draft, "preheader")) issues.push(draftIssue(draft, "preheader", "required"));
    if (!hasText(draft, "body")) issues.push(draftIssue(draft, "body", "required"));
    if (!hasText(draft, "cta")) issues.push(draftIssue(draft, "cta", "required"));
    if (!hasText(draft, "plainTextAlt")) issues.push(draftIssue(draft, "plainTextAlt", "required"));
    if (!maxText(draft, "subject", 45)) issues.push(draftIssue(draft, "subject", "must be 45 characters or fewer"));
    if (!maxText(draft, "preheader", 90)) issues.push(draftIssue(draft, "preheader", "must be 90 characters or fewer"));
    if (SPAM_TRIGGER_RE.test(emailText)) issues.push(draftIssue(draft, "body", "contains spam-trigger phrasing"));
  }
  else if (draft.format === "landing_hero") {
    if (!hasText(draft, "headline")) issues.push(draftIssue(draft, "headline", "required"));
    if (!hasText(draft, "subhead")) issues.push(draftIssue(draft, "subhead", "required"));
    if (!hasText(draft, "cta")) issues.push(draftIssue(draft, "cta", "required"));
    if (!maxText(draft, "headline", 70)) issues.push(draftIssue(draft, "headline", "must be 70 characters or fewer"));
    if (!maxText(draft, "subhead", 160)) issues.push(draftIssue(draft, "subhead", "must be 160 characters or fewer"));
    if (!maxText(draft, "cta", 30)) issues.push(draftIssue(draft, "cta", "must be 30 characters or fewer"));
  }
  else if (draft.format === "seo_snippet") {
    const meta = fieldText(draft, "metaDescription");
    if (!hasText(draft, "title")) issues.push(draftIssue(draft, "title", "required"));
    if (!hasText(draft, "metaDescription")) issues.push(draftIssue(draft, "metaDescription", "required"));
    if (!hasText(draft, "intent")) issues.push(draftIssue(draft, "intent", "required"));
    if (!maxText(draft, "title", 60)) issues.push(draftIssue(draft, "title", "must be 60 characters or fewer"));
    if (meta.length < 150 || meta.length > 160) issues.push(draftIssue(draft, "metaDescription", "must be 150 to 160 characters"));
  }
  return issues;
}

function validateDraftSetArtifact(artifact: DraftSetArtifact): string[] {
  const issues = artifact.drafts.flatMap(validateMarketingDraft);
  if (artifact.drafts.length === 0) issues.push("draft_set.drafts: must include at least one draft");
  return issues;
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

type ArtifactParseResult =
  | { ok: true; artifact: TeamArtifact }
  | { ok: false; error: string | null };

function parseDraftSetArtifact(input: Record<string, unknown>): { artifact: DraftSetArtifact | null; error: string | null } {
  if (input.kind !== "draft_set" || input.schemaVersion !== 1 || !Array.isArray(input.drafts)) {
    return { artifact: null, error: "draft_set: expected schemaVersion 1 and drafts array" };
  }
  const drafts = input.drafts.map(parseMarketingDraft);
  const malformedIndex = drafts.findIndex((draft) => draft === null);
  if (malformedIndex !== -1) {
    return { artifact: null, error: "draft_set.drafts[" + malformedIndex + "]: malformed draft" };
  }
  const artifact: DraftSetArtifact = {
    kind: "draft_set",
    schemaVersion: 1,
    drafts: drafts as MarketingDraft[],
  };
  const issues = validateDraftSetArtifact(artifact);
  return issues.length === 0 ? { artifact, error: null } : { artifact: null, error: issues[0] ?? "draft_set: invalid" };
}

function parseArtifact(input: unknown): ArtifactParseResult {
  if (input == null) return { ok: false, error: null };
  if (typeof input !== "object") return { ok: false, error: null };
  const artifact = input as Record<string, unknown>;
  if (artifact.kind === "scout_research") {
    const parsed = parseScoutResearchArtifact(artifact);
    return parsed ? { ok: true, artifact: parsed } : { ok: false, error: null };
  }
  if (artifact.kind === "draft_set") {
    const parsed = parseDraftSetArtifact(artifact);
    return parsed.artifact ? { ok: true, artifact: parsed.artifact } : { ok: false, error: parsed.error };
  }
  return { ok: false, error: null };
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
  const artifactResult = e.artifact === undefined || e.artifact === null ? null : parseArtifact(e.artifact);
  if (artifactResult && !artifactResult.ok) {
    if (artifactResult.error) {
      return {
        teamRunId: e.teamRunId,
        subtaskId: e.subtaskId,
        agentMemberId: e.agentMemberId,
        kind: "blocked",
        summary: "blocked: invalid draft_set artifact: " + artifactResult.error,
        branch: e.branch as string | null,
        createdAt: e.createdAt,
      };
    }
    return null;
  }
  return {
    teamRunId: e.teamRunId,
    subtaskId: e.subtaskId,
    agentMemberId: e.agentMemberId,
    kind: e.kind as TeamEventKind,
    summary: e.summary,
    branch: e.branch as string | null,
    ...(artifactResult?.ok ? { artifact: artifactResult.artifact } : {}),
    createdAt: e.createdAt,
  };
}
