import type {
  BrandVoiceArtifact,
  BrandVoiceProfile,
  ContentRubricMetric,
  DraftRubricScores,
  DraftSetArtifact,
  LensDraftReview,
  LensReviewArtifact,
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

function hasBlank(values: readonly string[]): boolean {
  return values.some((value) => !value.trim());
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

const CONTENT_RUBRIC_METRICS: readonly ContentRubricMetric[] = [
  "specificityToBusiness",
  "hookStrength",
  "clarity",
  "evidenceUse",
  "ctaQuality",
  "voiceConsistency",
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

function brandVoiceListIssue(profile: BrandVoiceProfile, field: keyof Pick<BrandVoiceProfile, "toneAxes" | "vocabularyDo" | "vocabularyDont" | "exampleLines">): string | null {
  const list = profile[field];
  if (list.length === 0) return "brand_voice.profile." + field + ": must include at least one item";
  if (hasBlank(list)) return "brand_voice.profile." + field + ": must not include blank items";
  return null;
}

function validateBrandVoiceArtifact(artifact: BrandVoiceArtifact): string[] {
  const issues: string[] = [];
  for (const field of ["toneAxes", "vocabularyDo", "vocabularyDont", "exampleLines"] as const) {
    const issue = brandVoiceListIssue(artifact.profile, field);
    if (issue) issues.push(issue);
  }
  if (!artifact.profile.sentenceRhythm.trim()) issues.push("brand_voice.profile.sentenceRhythm: required");
  if (hasBlank(artifact.sourceUrls)) issues.push("brand_voice.sourceUrls: must not include blank URLs");
  if (artifact.updatedFromOwnerEdit) {
    if (!artifact.updatedFromOwnerEdit.originalExcerpt.trim()) {
      issues.push("brand_voice.updatedFromOwnerEdit.originalExcerpt: required");
    }
    if (!artifact.updatedFromOwnerEdit.editedExcerpt.trim()) {
      issues.push("brand_voice.updatedFromOwnerEdit.editedExcerpt: required");
    }
    if (!artifact.updatedFromOwnerEdit.learnedAt.trim()) {
      issues.push("brand_voice.updatedFromOwnerEdit.learnedAt: required");
    }
  }
  return issues;
}

function rubricAverage(scores: DraftRubricScores): number {
  const total = CONTENT_RUBRIC_METRICS.reduce((sum, metric) => sum + scores[metric], 0);
  return Math.round((total / CONTENT_RUBRIC_METRICS.length) * 10) / 10;
}

function reviewIssue(review: Pick<LensDraftReview, "format" | "title">, field: string, message: string): string {
  return review.format + "." + field + ": " + message;
}

function parseRubricScores(input: unknown): DraftRubricScores | null {
  if (!isRecord(input)) return null;
  const scores: Partial<DraftRubricScores> = {};
  for (const metric of CONTENT_RUBRIC_METRICS) {
    const score = input[metric];
    if (typeof score !== "number") return null;
    scores[metric] = score;
  }
  return scores as DraftRubricScores;
}

function parseLensDraftReview(input: unknown): LensDraftReview | null {
  if (!isRecord(input)) return null;
  if (typeof input.format !== "string" || !MARKETING_DRAFT_FORMATS.includes(input.format as MarketingDraftFormat)) {
    return null;
  }
  if (typeof input.title !== "string" || typeof input.averageScore !== "number" || typeof input.revisionNote !== "string") {
    return null;
  }
  const scores = parseRubricScores(input.scores);
  if (!scores) return null;
  const revisedDraft = input.revisedDraft === undefined ? undefined : parseMarketingDraft(input.revisedDraft);
  if (input.revisedDraft !== undefined && !revisedDraft) return null;
  return {
    format: input.format as MarketingDraftFormat,
    title: input.title,
    scores,
    averageScore: input.averageScore,
    revisionNote: input.revisionNote,
    ...(revisedDraft ? { revisedDraft } : {}),
  };
}

function validateLensReviewArtifact(artifact: LensReviewArtifact): string[] {
  const issues: string[] = [];
  if (artifact.threshold < 1 || artifact.threshold > 5) {
    issues.push("lens_review.threshold: must be between 1 and 5");
  }
  if (!artifact.summary.trim()) issues.push("lens_review.summary: required");
  if (artifact.reviews.length === 0) issues.push("lens_review.reviews: must include at least one draft review");
  for (const review of artifact.reviews) {
    if (!review.title.trim()) issues.push(reviewIssue(review, "title", "required"));
    for (const metric of CONTENT_RUBRIC_METRICS) {
      const score = review.scores[metric];
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        issues.push(reviewIssue(review, "scores." + metric, "must be an integer from 1 to 5"));
      }
    }
    const expectedAverage = rubricAverage(review.scores);
    if (Math.abs(review.averageScore - expectedAverage) > 0.05) {
      issues.push(reviewIssue(review, "averageScore", "must equal computed rubric average " + expectedAverage));
    }
    if (review.revisionNote.trim().length < 12) {
      issues.push(reviewIssue(review, "revisionNote", "must be a concrete revision note"));
    }
    if (review.averageScore < artifact.threshold) {
      if (!review.revisedDraft) {
        issues.push(reviewIssue(review, "revisedDraft", "required when averageScore is below threshold"));
      } else {
        if (review.revisedDraft.format !== review.format) {
          issues.push(reviewIssue(review, "revisedDraft.format", "must match reviewed draft format"));
        }
        for (const issue of validateMarketingDraft(review.revisedDraft)) {
          const separator = issue.indexOf(": ");
          const field = separator === -1 ? "revisedDraft" : issue.slice(0, separator).split(".").slice(1).join(".");
          const message = separator === -1 ? issue : issue.slice(separator + 2);
          issues.push(reviewIssue(review, "revisedDraft." + field, message));
        }
      }
    }
  }
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

function parseBrandVoiceProfile(input: unknown): BrandVoiceProfile | null {
  if (!isRecord(input)) return null;
  if (
    !isStringArray(input.toneAxes) ||
    !isStringArray(input.vocabularyDo) ||
    !isStringArray(input.vocabularyDont) ||
    typeof input.sentenceRhythm !== "string" ||
    !isStringArray(input.exampleLines)
  ) {
    return null;
  }
  return {
    toneAxes: input.toneAxes,
    vocabularyDo: input.vocabularyDo,
    vocabularyDont: input.vocabularyDont,
    sentenceRhythm: input.sentenceRhythm,
    exampleLines: input.exampleLines,
  };
}

function parseBrandVoiceArtifact(input: Record<string, unknown>): { artifact: BrandVoiceArtifact | null; error: string | null } {
  if (input.kind !== "brand_voice" || input.schemaVersion !== 1 || !isStringArray(input.sourceUrls)) {
    return { artifact: null, error: "brand_voice: expected schemaVersion 1, profile, and sourceUrls array" };
  }
  const profile = parseBrandVoiceProfile(input.profile);
  if (!profile) {
    return { artifact: null, error: "brand_voice.profile: malformed profile" };
  }
  let updatedFromOwnerEdit: BrandVoiceArtifact["updatedFromOwnerEdit"] | undefined;
  if (input.updatedFromOwnerEdit !== undefined) {
    if (!isRecord(input.updatedFromOwnerEdit)) {
      return { artifact: null, error: "brand_voice.updatedFromOwnerEdit: malformed owner edit" };
    }
    const edit = input.updatedFromOwnerEdit;
    if (
      typeof edit.originalExcerpt !== "string" ||
      typeof edit.editedExcerpt !== "string" ||
      typeof edit.learnedAt !== "string"
    ) {
      return { artifact: null, error: "brand_voice.updatedFromOwnerEdit: malformed owner edit" };
    }
    updatedFromOwnerEdit = {
      originalExcerpt: edit.originalExcerpt,
      editedExcerpt: edit.editedExcerpt,
      learnedAt: edit.learnedAt,
    };
  }
  const artifact: BrandVoiceArtifact = {
    kind: "brand_voice",
    schemaVersion: 1,
    profile,
    sourceUrls: input.sourceUrls,
    ...(updatedFromOwnerEdit ? { updatedFromOwnerEdit } : {}),
  };
  const issues = validateBrandVoiceArtifact(artifact);
  return issues.length === 0 ? { artifact, error: null } : { artifact: null, error: issues[0] ?? "brand_voice: invalid" };
}

type ArtifactParseResult =
  | { ok: true; artifact: TeamArtifact }
  | { ok: false; kind: string | null; error: string | null };

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

function parseLensReviewArtifact(input: Record<string, unknown>): { artifact: LensReviewArtifact | null; error: string | null } {
  if (
    input.kind !== "lens_review" ||
    input.schemaVersion !== 1 ||
    typeof input.threshold !== "number" ||
    typeof input.summary !== "string" ||
    !Array.isArray(input.reviews)
  ) {
    return { artifact: null, error: "lens_review: expected schemaVersion 1, threshold, summary, and reviews array" };
  }
  const reviews = input.reviews.map(parseLensDraftReview);
  const malformedIndex = reviews.findIndex((review) => review === null);
  if (malformedIndex !== -1) {
    return { artifact: null, error: "lens_review.reviews[" + malformedIndex + "]: malformed review" };
  }
  const artifact: LensReviewArtifact = {
    kind: "lens_review",
    schemaVersion: 1,
    threshold: input.threshold,
    summary: input.summary,
    reviews: reviews as LensDraftReview[],
  };
  const issues = validateLensReviewArtifact(artifact);
  return issues.length === 0 ? { artifact, error: null } : { artifact: null, error: issues[0] ?? "lens_review: invalid" };
}

function parseArtifact(input: unknown): ArtifactParseResult {
  if (input == null) return { ok: false, kind: null, error: null };
  if (typeof input !== "object") return { ok: false, kind: null, error: null };
  const artifact = input as Record<string, unknown>;
  if (artifact.kind === "scout_research") {
    const parsed = parseScoutResearchArtifact(artifact);
    return parsed ? { ok: true, artifact: parsed } : { ok: false, kind: "scout_research", error: null };
  }
  if (artifact.kind === "brand_voice") {
    const parsed = parseBrandVoiceArtifact(artifact);
    return parsed.artifact ? { ok: true, artifact: parsed.artifact } : { ok: false, kind: "brand_voice", error: parsed.error };
  }
  if (artifact.kind === "draft_set") {
    const parsed = parseDraftSetArtifact(artifact);
    return parsed.artifact ? { ok: true, artifact: parsed.artifact } : { ok: false, kind: "draft_set", error: parsed.error };
  }
  if (artifact.kind === "lens_review") {
    const parsed = parseLensReviewArtifact(artifact);
    return parsed.artifact ? { ok: true, artifact: parsed.artifact } : { ok: false, kind: "lens_review", error: parsed.error };
  }
  return { ok: false, kind: null, error: null };
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
        summary: "blocked: invalid " + (artifactResult.kind ?? "team") + " artifact: " + artifactResult.error,
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
