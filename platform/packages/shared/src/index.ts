/**
 * Cross-cutting contracts shared between the Reload server, web client, and CLI.
 * Keep this package free of runtime dependencies — types and small pure helpers only.
 */

/** Health of a single backing dependency. */
export type DependencyState = "up" | "down";

/** Overall service health, returned by `GET /healthz`. */
export interface HealthResponse {
  status: "ok" | "degraded";
  db: DependencyState;
  redis: DependencyState;
}

/** Liveness probe response (`GET /livez`) — the process is up. */
export interface LivenessResponse {
  status: "ok";
}

/**
 * Readiness probe response (`GET /readyz`) — every backing dependency is reachable.
 * Served with HTTP 200 when ready, 503 when not (`status: "not_ready"`).
 */
export interface ReadinessResponse {
  status: "ready" | "not_ready";
  db: DependencyState;
  redis: DependencyState;
  loops?: {
    status: "ready" | "not_ready";
    disabledCritical: string[];
  };
}

/**
 * Build/version probe response (`GET /version`, #292) — the git SHA baked into the running image.
 * This is what lets a deploy externally verify the running release actually ADVANCED: a no-op deploy
 * (path-filter miss, unset deploy-token guard, or a release that never cut over) leaves the OLD image
 * live, which `/readyz` (dependency reachability only) cannot detect — exactly the "stuck on v80 while
 * CI is green" failure (#292). `version` is `""` when the image was built without a `GIT_SHA` build-arg
 * (local/dev), so consumers MUST treat an empty value as "unknown" and never as a confirmed match.
 */
export interface VersionResponse {
  version: string;
}

// ---- approval gates (#13) ---------------------------------------------------

/** Lifecycle of an approval request (#13). `approved` is transient between decision and execution. */
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "executed"
  | "failed"
  | "rejected"
  | "expired";

/** Action types the executor registry can run (#13). */
export type ApprovalActionType = "chat.post_message" | "external.send" | "billing.refund";

/** A workspace policy rule: which action types pause for a human (#13). */
export interface ApprovalPolicyDto {
  id: string;
  actionType: string;
  requireApproval: boolean;
  maxAutoAmount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A gated action awaiting (or having received) a human decision (#13). */
export interface ApprovalRequestDto {
  id: string;
  workspaceId: string;
  requesterMemberId: string;
  actionType: string;
  payload: Record<string, unknown>;
  amount: number | null;
  summary: string;
  status: ApprovalStatus;
  reason: string | null;
  decidedByMemberId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An append-only audit row for an approval request (#13). */
export interface ApprovalEventDto {
  id: string;
  requestId: string;
  type: "requested" | "approved" | "rejected" | "expired" | "executed" | "failed";
  actorMemberId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Response of `POST /workspaces/:wid/actions`: gated (pending) or auto-executed. */
export type SubmitActionResponse =
  | { status: "pending"; reason: string; request: ApprovalRequestDto }
  | { status: "executed"; result: Record<string, unknown>; request: ApprovalRequestDto };

/** Read-only dry run of the workspace approval policy, used by the policy control center (#1291). */
export type PolicySimulationOutcome = "auto_runs" | "queues_for_approval" | "blocked";

export interface PolicySimulationInput {
  actionType: string;
  amount?: number | null;
}

export interface PolicySimulationResult {
  actionType: string;
  amount: number | null;
  outcome: PolicySimulationOutcome;
  reason: string;
  rollbackStatus: string;
}

// ---- team mode (#TeamMode) --------------------------------------------------

/**
 * The lifecycle a teammate broadcasts on the shared team channel so peers can keep each other in
 * the loop: `started` (claimed a subtask), `milestone` (progress worth announcing), `blocked`
 * (stuck / failed — peers should avoid depending on it), `needs_handoff` (wants another agent to
 * pick something up), `done` (subtask finished). Reading recent events before acting is how agents
 * avoid duplicate or conflicting work.
 */
export type TeamEventKind = "started" | "milestone" | "blocked" | "needs_handoff" | "done";

/** Typed artifacts teammates can hand off during a team run. */
export type TeamArtifactKind = "scout_research" | "brand_voice" | "draft_set" | "lens_review";

/**
 * Scout's research handoff for downstream writers. This is intentionally compact enough to fit in a
 * room event but structured enough that Quill cannot fall back to generic filler.
 */
export interface ScoutResearchArtifact {
  kind: "scout_research";
  schemaVersion: 1;
  siteSummary: string;
  icp: string;
  positioning: string;
  proofPoints: string[];
  competitors: string[];
  toneNotes: string;
  sourceUrls: string[];
}

/** The workspace voice model every channel draft must follow. */
export interface BrandVoiceProfile {
  toneAxes: string[];
  vocabularyDo: string[];
  vocabularyDont: string[];
  sentenceRhythm: string;
  exampleLines: string[];
}

/** Scout/owner-edit handoff that keeps copy consistent across runs and channels. */
export interface BrandVoiceArtifact {
  kind: "brand_voice";
  schemaVersion: 1;
  profile: BrandVoiceProfile;
  sourceUrls: string[];
  updatedFromOwnerEdit?: {
    originalExcerpt: string;
    editedExcerpt: string;
    learnedAt: string;
  };
}

/** The first channel-native formats Quill can hand off to Lens/owner review. */
export type MarketingDraftFormat =
  | "google_rsa"
  | "meta_ad"
  | "linkedin_post"
  | "x_thread"
  | "email"
  | "landing_hero"
  | "seo_snippet";

export interface MarketingDraft {
  format: MarketingDraftFormat;
  title: string;
  fields: Record<string, string | string[]>;
  /** Scout proof points or source URLs used by this draft. */
  citations: string[];
}

/** A validated bundle of channel-native drafts from Quill. */
export interface DraftSetArtifact {
  kind: "draft_set";
  schemaVersion: 1;
  drafts: MarketingDraft[];
}

export type ContentRubricMetric =
  | "specificityToBusiness"
  | "hookStrength"
  | "clarity"
  | "evidenceUse"
  | "ctaQuality"
  | "voiceConsistency";

export type DraftRubricScores = Record<ContentRubricMetric, number>;

export interface LensDraftReview {
  format: MarketingDraftFormat;
  title: string;
  scores: DraftRubricScores;
  averageScore: number;
  revisionNote: string;
  /** Required when the draft falls below the quality threshold. */
  revisedDraft?: MarketingDraft;
}

/** Lens' structured quality pass over Quill's channel-native drafts. */
export interface LensReviewArtifact {
  kind: "lens_review";
  schemaVersion: 1;
  threshold: number;
  summary: string;
  reviews: LensDraftReview[];
}

export type TeamArtifact = ScoutResearchArtifact | BrandVoiceArtifact | DraftSetArtifact | LensReviewArtifact;

export interface DraftValidationIssue {
  format: MarketingDraftFormat;
  title: string;
  field: string;
  message: string;
}

export interface BrandVoiceValidationIssue {
  field: string;
  message: string;
}

const SPAM_TRIGGER_RE = /\b(?:free money|guaranteed|risk-free|act now|limited time|winner|cash bonus)\b/i;
export const CONTENT_QUALITY_THRESHOLD = 4;
export const CONTENT_RUBRIC_METRICS: readonly ContentRubricMetric[] = [
  "specificityToBusiness",
  "hookStrength",
  "clarity",
  "evidenceUse",
  "ctaQuality",
  "voiceConsistency",
];

function strings(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function pushRequired(
  issues: DraftValidationIssue[],
  draft: MarketingDraft,
  field: string,
  value: string | string[] | undefined,
): void {
  if (typeof value === "string" && value.trim()) return;
  if (Array.isArray(value) && value.some((item) => item.trim())) return;
  issues.push({ format: draft.format, title: draft.title, field, message: "required" });
}

function pushMax(
  issues: DraftValidationIssue[],
  draft: MarketingDraft,
  field: string,
  value: string,
  max: number,
): void {
  if (value.length <= max) return;
  issues.push({
    format: draft.format,
    title: draft.title,
    field,
    message: "must be " + max + " characters or fewer",
  });
}

function validateGoogleRsa(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  const headlines = strings(draft.fields.headlines);
  const descriptions = strings(draft.fields.descriptions);
  if (headlines.length !== 15) {
    issues.push({ format: draft.format, title: draft.title, field: "headlines", message: "must include exactly 15 headlines" });
  }
  if (descriptions.length !== 4) {
    issues.push({ format: draft.format, title: draft.title, field: "descriptions", message: "must include exactly 4 descriptions" });
  }
  headlines.forEach((headline, index) => pushMax(issues, draft, "headlines[" + index + "]", headline, 30));
  descriptions.forEach((description, index) => pushMax(issues, draft, "descriptions[" + index + "]", description, 90));
}

function validateSocialAd(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  pushRequired(issues, draft, "hook", draft.fields.hook);
  pushRequired(issues, draft, "body", draft.fields.body);
  pushRequired(issues, draft, "cta", draft.fields.cta);
  pushMax(issues, draft, "hook", stringValue(draft.fields.hook), 125);
  pushMax(issues, draft, "headline", stringValue(draft.fields.headline), 40);
  pushMax(issues, draft, "description", stringValue(draft.fields.description), 30);
}

function validateLinkedInPost(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  pushRequired(issues, draft, "hook", draft.fields.hook);
  pushRequired(issues, draft, "body", draft.fields.body);
  pushMax(issues, draft, "hook", stringValue(draft.fields.hook), 180);
  pushMax(issues, draft, "cta", stringValue(draft.fields.cta), 120);
}

function validateXThread(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  const tweets = strings(draft.fields.tweets);
  if (tweets.length < 2 || tweets.length > 8) {
    issues.push({ format: draft.format, title: draft.title, field: "tweets", message: "must include 2 to 8 tweets" });
  }
  tweets.forEach((tweet, index) => pushMax(issues, draft, "tweets[" + index + "]", tweet, 280));
}

function validateEmail(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  pushRequired(issues, draft, "subject", draft.fields.subject);
  pushRequired(issues, draft, "preheader", draft.fields.preheader);
  pushRequired(issues, draft, "body", draft.fields.body);
  pushRequired(issues, draft, "cta", draft.fields.cta);
  pushRequired(issues, draft, "plainTextAlt", draft.fields.plainTextAlt);
  pushMax(issues, draft, "subject", stringValue(draft.fields.subject), 45);
  pushMax(issues, draft, "preheader", stringValue(draft.fields.preheader), 90);
  const emailText = [draft.fields.subject, draft.fields.preheader, draft.fields.body].map(stringValue).join(" ");
  if (SPAM_TRIGGER_RE.test(emailText)) {
    issues.push({ format: draft.format, title: draft.title, field: "body", message: "contains spam-trigger phrasing" });
  }
}

function validateLandingHero(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  pushRequired(issues, draft, "headline", draft.fields.headline);
  pushRequired(issues, draft, "subhead", draft.fields.subhead);
  pushRequired(issues, draft, "cta", draft.fields.cta);
  pushMax(issues, draft, "headline", stringValue(draft.fields.headline), 70);
  pushMax(issues, draft, "subhead", stringValue(draft.fields.subhead), 160);
  pushMax(issues, draft, "cta", stringValue(draft.fields.cta), 30);
}

function validateSeoSnippet(draft: MarketingDraft, issues: DraftValidationIssue[]): void {
  pushRequired(issues, draft, "title", draft.fields.title);
  pushRequired(issues, draft, "metaDescription", draft.fields.metaDescription);
  pushRequired(issues, draft, "intent", draft.fields.intent);
  pushMax(issues, draft, "title", stringValue(draft.fields.title), 60);
  const meta = stringValue(draft.fields.metaDescription);
  if (meta.length < 150 || meta.length > 160) {
    issues.push({
      format: draft.format,
      title: draft.title,
      field: "metaDescription",
      message: "must be 150 to 160 characters",
    });
  }
}

export function validateMarketingDraft(draft: MarketingDraft): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  if (!draft.title.trim()) {
    issues.push({ format: draft.format, title: draft.title, field: "title", message: "required" });
  }
  if (draft.citations.length === 0) {
    issues.push({ format: draft.format, title: draft.title, field: "citations", message: "must cite Scout proofPoints or sourceUrls" });
  }
  if (draft.format === "google_rsa") validateGoogleRsa(draft, issues);
  else if (draft.format === "meta_ad") validateSocialAd(draft, issues);
  else if (draft.format === "linkedin_post") validateLinkedInPost(draft, issues);
  else if (draft.format === "x_thread") validateXThread(draft, issues);
  else if (draft.format === "email") validateEmail(draft, issues);
  else if (draft.format === "landing_hero") validateLandingHero(draft, issues);
  else if (draft.format === "seo_snippet") validateSeoSnippet(draft, issues);
  return issues;
}

export function validateDraftSetArtifact(artifact: DraftSetArtifact): DraftValidationIssue[] {
  const issues = artifact.drafts.flatMap(validateMarketingDraft);
  if (artifact.drafts.length === 0) {
    issues.push({ format: "email", title: "draft_set", field: "drafts", message: "must include at least one draft" });
  }
  return issues;
}

function pushBrandVoiceStringListIssue(
  issues: BrandVoiceValidationIssue[],
  profile: BrandVoiceProfile,
  field: keyof Pick<BrandVoiceProfile, "toneAxes" | "vocabularyDo" | "vocabularyDont" | "exampleLines">,
): void {
  const list = profile[field];
  if (list.length === 0) {
    issues.push({ field, message: "must include at least one item" });
  }
  if (list.some((item) => !item.trim())) {
    issues.push({ field, message: "must not include blank items" });
  }
}

export function validateBrandVoiceArtifact(artifact: BrandVoiceArtifact): BrandVoiceValidationIssue[] {
  const issues: BrandVoiceValidationIssue[] = [];
  pushBrandVoiceStringListIssue(issues, artifact.profile, "toneAxes");
  pushBrandVoiceStringListIssue(issues, artifact.profile, "vocabularyDo");
  pushBrandVoiceStringListIssue(issues, artifact.profile, "vocabularyDont");
  pushBrandVoiceStringListIssue(issues, artifact.profile, "exampleLines");
  if (!artifact.profile.sentenceRhythm.trim()) {
    issues.push({ field: "sentenceRhythm", message: "required" });
  }
  if (artifact.sourceUrls.some((url) => !url.trim())) {
    issues.push({ field: "sourceUrls", message: "must not include blank URLs" });
  }
  if (artifact.updatedFromOwnerEdit) {
    if (!artifact.updatedFromOwnerEdit.originalExcerpt.trim()) {
      issues.push({ field: "updatedFromOwnerEdit.originalExcerpt", message: "required" });
    }
    if (!artifact.updatedFromOwnerEdit.editedExcerpt.trim()) {
      issues.push({ field: "updatedFromOwnerEdit.editedExcerpt", message: "required" });
    }
    if (!artifact.updatedFromOwnerEdit.learnedAt.trim()) {
      issues.push({ field: "updatedFromOwnerEdit.learnedAt", message: "required" });
    }
  }
  return issues;
}

export function contentRubricAverage(scores: DraftRubricScores): number {
  const total = CONTENT_RUBRIC_METRICS.reduce((sum, metric) => sum + scores[metric], 0);
  return Math.round((total / CONTENT_RUBRIC_METRICS.length) * 10) / 10;
}

function pushRubricIssue(
  issues: DraftValidationIssue[],
  review: Pick<LensDraftReview, "format" | "title">,
  field: string,
  message: string,
): void {
  issues.push({ format: review.format, title: review.title, field, message });
}

export function validateLensReviewArtifact(artifact: LensReviewArtifact): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];
  if (artifact.threshold < 1 || artifact.threshold > 5) {
    issues.push({ format: "email", title: "lens_review", field: "threshold", message: "must be between 1 and 5" });
  }
  if (!artifact.summary.trim()) {
    issues.push({ format: "email", title: "lens_review", field: "summary", message: "required" });
  }
  if (artifact.reviews.length === 0) {
    issues.push({ format: "email", title: "lens_review", field: "reviews", message: "must include at least one draft review" });
  }
  for (const review of artifact.reviews) {
    if (!review.title.trim()) pushRubricIssue(issues, review, "title", "required");
    for (const metric of CONTENT_RUBRIC_METRICS) {
      const score = review.scores[metric];
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        pushRubricIssue(issues, review, "scores." + metric, "must be an integer from 1 to 5");
      }
    }
    const expectedAverage = contentRubricAverage(review.scores);
    if (Math.abs(review.averageScore - expectedAverage) > 0.05) {
      pushRubricIssue(issues, review, "averageScore", "must equal computed rubric average " + expectedAverage);
    }
    if (review.revisionNote.trim().length < 12) {
      pushRubricIssue(issues, review, "revisionNote", "must be a concrete revision note");
    }
    if (review.averageScore < artifact.threshold) {
      if (!review.revisedDraft) {
        pushRubricIssue(issues, review, "revisedDraft", "required when averageScore is below threshold");
      } else {
        if (review.revisedDraft.format !== review.format) {
          pushRubricIssue(issues, review, "revisedDraft.format", "must match reviewed draft format");
        }
        for (const issue of validateMarketingDraft(review.revisedDraft)) {
          pushRubricIssue(issues, review, "revisedDraft." + issue.field, issue.message);
        }
      }
    }
  }
  return issues;
}

/** One structured status event on a team run's channel. */
export interface TeamEvent {
  /** Groups every event belonging to one team run. */
  teamRunId: string;
  /** Which subtask/branch this event is about. */
  subtaskId: string;
  /** The agent member that emitted the event. */
  agentMemberId: string;
  kind: TeamEventKind;
  /** Human-readable one-liner describing what happened. */
  summary: string;
  /** The branch the agent is working on, or null before one is assigned. */
  branch: string | null;
  /** Optional structured handoff artifact produced by this event. */
  artifact?: TeamArtifact | null;
  /** ISO-8601 timestamp the event was created. */
  createdAt: string;
}

// ---- git / PR / diff / review workflow (#51) --------------------------------

/** Which slice of a session's git history a diff covers (#51). */
export type DiffMode = "cumulative" | "turn";

/** Per-file change summary parsed from `git diff --numstat` (#51). */
export interface DiffFileStat {
  path: string;
  /** Lines added; null for a binary file (git reports `-`). */
  additions: number | null;
  /** Lines removed; null for a binary file. */
  deletions: number | null;
  binary: boolean;
}

/** A session's diff: the unified patch plus per-file stats (#51). */
export interface SessionDiff {
  sessionId: string;
  branch: string;
  baseBranch: string;
  mode: DiffMode;
  /** The unified-diff patch text (may be empty when there are no changes). */
  patch: string;
  files: DiffFileStat[];
}

/** Lifecycle of a pull request opened from a session (#51). */
export type PullRequestState = "draft" | "open" | "merged" | "closed";

/** CI/checks rollup for a PR, mirrored from GitHub (#51). */
export type ChecksStatus = "unknown" | "pending" | "success" | "failure";

/** One CI check run on a PR's head (#51). */
export interface CheckRunDto {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped" | "cancelled" | null;
  detailsUrl: string | null;
}

/** A pull request opened from an agent session's branch (#51). */
export interface PullRequestDto {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string | null;
  number: number | null;
  url: string | null;
  title: string;
  body: string | null;
  draft: boolean;
  state: PullRequestState;
  checksStatus: ChecksStatus;
  baseBranch: string;
  headBranch: string;
  provider: "none" | "gh";
  createdByMemberId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A review comment on a session's diff, optionally delivered back to the agent (#51). */
export interface ReviewCommentDto {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string;
  pullRequestId: string | null;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  body: string;
  authorMemberId: string | null;
  /** The follow-up session this comment was forwarded to (the round-trip), or null. */
  deliveredToSessionId: string | null;
  createdAt: string;
}

// ---- run tab / preview + annotations (#56) ----------------------------------

/** Lifecycle of a session's run process (#56). Ephemeral — a child of the server, never persisted. */
export type RunStatus = "idle" | "starting" | "running" | "stopped" | "exited" | "failed";

/** A session's run-process state, surfaced to the Run tab (#56). */
export interface RunState {
  sessionId: string;
  status: RunStatus;
  /** The detected (or configured) localhost preview URL once the app is up; null otherwise. */
  url: string | null;
  /** Exit code once the process has exited on its own; null otherwise. */
  exitCode: number | null;
  /** A spawn/runtime error message when status is `failed`; null otherwise. */
  error: string | null;
  /** A bounded tail of the process's combined stdout/stderr lines (oldest first). */
  logs: string[];
}

/**
 * A user annotation dropped on the running preview (#56). Coordinates are **normalized fractions**
 * (0–1) of the preview viewport, so they stay stable across pixel sizes. The localhost app is
 * cross-origin, so an annotation is a coordinate + the user's note — never page DOM content.
 */
export interface PreviewAnnotation {
  /** Normalized x (0–1) of the annotation anchor within the preview viewport. */
  x: number;
  /** Normalized y (0–1) of the annotation anchor within the preview viewport. */
  y: number;
  /** Optional normalized width (0–1) of a dragged region. */
  width?: number;
  /** Optional normalized height (0–1) of a dragged region. */
  height?: number;
  /** The user's note describing what to change at this spot. */
  note: string;
  /** The preview URL the annotation was made against. */
  pageUrl: string;
}

// ---- deploy to a live url (#73) ---------------------------------------------

/**
 * Lifecycle of a deployment (#73). A deploy is a durable one-shot job: `queued → building →
 * ready(url) | error`. `unhealthy` is set when a health check fails and a restart can't recover it;
 * `rolled_back` marks a deployment that re-promoted a prior good one. Every deploy is immutable — the
 * row history is the backup set.
 */
export type DeployStatus = "queued" | "building" | "ready" | "error" | "unhealthy" | "rolled_back";

/** A deployment surfaced to the web Deploy tab (#73). Server-only fields are not exposed. */
export interface DeploymentDto {
  id: string;
  sessionId: string;
  channelId: string;
  /** The hosting backend that produced it (`dryrun` | `vercel`). */
  provider: string;
  status: DeployStatus;
  /** The live HTTPS URL once ready; null while building or on error. */
  url: string | null;
  /** The detected/declared framework. */
  framework: string | null;
  /** A (redacted) error message when status is `error`/`unhealthy`. */
  error: string | null;
  /** Why this deploy ran (`deploy` | `push` | `rollback`). */
  reason: string | null;
  /** The prior deployment this one re-promoted, when status is `rolled_back`. */
  rolledBackFromId: string | null;
  /** A bounded tail of (redacted) build/deploy log lines, oldest first. */
  logs: string[];
  createdAt: string;
}

/** A payment link minted for a session's deployed app (#98). Server-only fields are not exposed. */
export interface PaymentLinkDto {
  id: string;
  sessionId: string;
  channelId: string;
  /** The deployment this link collects payment for, when attached. */
  deploymentId: string | null;
  /** The billing backend that produced it (`none` | `stripe`). */
  provider: string;
  /** The hosted URL a customer pays at. */
  url: string;
  amountCents: number;
  currency: string;
  /** Recurring interval (`month`…), or null for a one-time charge. */
  interval: string | null;
  createdAt: string;
}

/** One recorded inbound payment surfaced to the dashboard (#98). */
export interface RevenueEventDto {
  id: string;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

/** Revenue-per-venture summary for the #71 usage dashboard (#98). */
export interface RevenueSummaryDto {
  currency: string;
  totalCents: number;
  paymentCount: number;
  /** Count of willingness-to-pay evidence rows (consumed by the #96 venture scorecard). */
  evidenceCount: number;
  recent: RevenueEventDto[];
}

/** One customer-visible invoice/receipt record (#860). */
export interface BillingInvoiceDto {
  id: string;
  providerEventId: string;
  providerInvoiceId: string;
  number: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  status: string | null;
  amountCents: number;
  currency: string;
  createdAt: string;
}

/** GET /workspaces/:wid/billing/invoices payload (#860). */
export interface BillingInvoicesResponseDto {
  invoices: BillingInvoiceDto[];
}

/** One pricing plan card on the `/pricing` page (#125). Mirrors the server's pure plan catalog. */
export interface PlanDto {
  /** Stable plan key (`starter` | `pro` | `agency`). */
  key: string;
  name: string;
  /** Warm, chatty one-liner (ipop voice). */
  tagline: string;
  priceCents: number;
  currency: string;
  interval: string;
  /** Tenant cap: agent seats. */
  agentSeats: number;
  /** Tenant cap: monthly spend ceiling on agent sessions (cents) → the #71 budget cap. */
  monthlySessionBudgetCents: number;
  /** Tenant cap: department fleet size. */
  fleetSize: number;
  /** Buyer-visible limits that become quota meters and upgrade prompts in the product. */
  productLimits: {
    activeCampaignLanes: number;
    connectedChannels: number;
    dailyOutreachSends: number;
    approvalQueueSize: number;
    dashboardHistoryDays: number;
  };
  /** Outcome-first summary: what useful work this tier should produce every day. */
  dailyValue: string;
  /** Plain-English limit that turns value into an upgrade moment. */
  dailyLimit: string;
  /** The buyer-facing reason to upgrade from this tier. */
  upgradeTrigger: string;
  highlights: string[];
  /** The recommended tier (rendered with a "most popular" treatment). */
  featured: boolean;
}

/** The workspace's currently active plan + its resolved caps (#125). Null until a plan is activated. */
export interface ActivePlanDto {
  planKey: string;
  status: string;
  agentSeats: number;
  monthlySessionBudgetCents: number;
  fleetSize: number;
  activatedAt: string;
}

/** Sticky pricing experiment assignment for this viewer (#608). */
export interface PricingExperimentAssignmentDto {
  experimentId: string;
  assignmentId: string;
  variantKey: string;
  planKey: string;
}

export interface PricingExperimentVariantReportDto {
  variantKey: string;
  planKey: string;
  assignments: number;
  checkouts: number;
  conversions: number;
  revenueCents: number;
  conversionRate: number;
  revenuePerVisitorCents: number;
  liftVsControlBps: number | null;
  significance: string;
}

export interface PricingExperimentReportDto {
  experimentId: string;
  workspaceId: string;
  name: string;
  status: string;
  controlVariantKey: string;
  minSampleSize: number;
  variants: PricingExperimentVariantReportDto[];
}

/** `GET /workspaces/:wid/billing/plans` payload (#125): the catalog + the active plan. */
export interface PlansResponseDto {
  plans: PlanDto[];
  current: ActivePlanDto | null;
  pricingExperiment?: PricingExperimentAssignmentDto | null;
}

/** `POST /workspaces/:wid/billing/checkout` success payload (#125): the hosted checkout URL. */
export interface CheckoutResponseDto {
  url: string;
  planKey: string;
  billingInterval?: "month" | "year";
  pricingAssignmentId?: string | null;
}

export interface BillingQuotaMeterDto {
  resource:
    | "active_campaign_lanes"
    | "connected_channels"
    | "daily_outreach_sends"
    | "approval_queue";
  label: string;
  used: number;
  limit: number;
  remaining: number;
  upgradeTrigger: string;
  window?: string;
}

/**
 * `GET /workspaces/:wid/billing/status` payload (#481 go-live). Lets the UI render the real billing state
 * instead of a hardcoded "test mode" banner: `live` is true ONLY when the `stripe` backend runs in `live`
 * mode (real money). No secrets — just the configured provider + declared mode.
 */
export interface BillingStatusDto {
  /** Configured backend (`none` | `stripe`). */
  provider: string;
  /** Declared mode (`test` | `live`). */
  mode: string;
  /** True iff real money can be charged right now (stripe + live). */
  live: boolean;
  /** Live plan quota meters for upgrade moments (#1290). Empty until a plan is active. */
  quotas?: BillingQuotaMeterDto[];
}

// The wire codec (marker prefix + encode/parse) lives in the server (`src/team/protocol.ts`):
// this package is consumed unbuilt and stays strictly type-only with no runtime exports.
