/**
 * Wire types for the Reload web client — a hand-mirrored copy of the server's REST + WebSocket
 * contract (see `platform/.context/api-contract.md`). The server does not export these from
 * `@reload/shared` (only the health types live there), so we keep a typed, documented copy here.
 *
 * Field-name landmines preserved deliberately (they differ from intuition):
 *  - message text is `body` (not `content`/`text`)
 *  - thread parent is `parentMessageId` (not `threadId`/`parentId`)
 *  - author is `authorMemberId` (a *member* id), and a message carries NO display name / timestamp
 *  - identity carries `kind: "human" | "agent"` (there is no `isAgent` boolean)
 */

import type { DeployStatus, PullRequestDto, ReviewCommentDto, RunStatus } from "@reload/shared";

export type MemberKind = "human" | "agent";
export type ChannelKind = "public" | "dm";
export type PresenceStatus = "online" | "away" | "offline";

/** Connect Claude credential state (#68), from `GET /me/agent-credentials`. Never carries the token. */
export interface CredentialStatus {
  connected: boolean;
  fingerprint: string | null;
  connectedAt?: string | null;
  /** The owner-picked fleet model (#246); null ⇒ the deployment default. */
  model?: string | null;
  /** When the stored credential was last observed unusable (#365); null ⇒ none observed. */
  lastAuthFailureAt?: string | null;
}

/** Connection-health state (#365): the tri-state the owner sees at a glance. */
export type ClaudeConnectionHealthState = "not_connected" | "connected" | "expired";

/** The connection-health signal (#365), from `GET /me/claude/health`. Derived purely; never a token. */
export interface ClaudeConnectionHealth {
  state: ClaudeConnectionHealthState;
  /** A short, owner-facing reason; present only when the connection needs the owner's attention. */
  reason: string | null;
}

/** The selectable fleet models (#246), from `GET /me/agent-models`. */
export interface AgentModels {
  models: string[];
  default: string;
}

/** The Connect-Claude offer (#262), from `GET /me/claude/connect`. What the panel should feature. */
export interface ClaudeConnectOffer {
  /** `managed_oauth` = one-click button; `paste_token` = today's Advanced setup-token paste. */
  method: "managed_oauth" | "paste_token";
  /** True iff the one-click managed flow is the featured path for this workspace. */
  managed: boolean;
  /** `available` = works now; `coming_soon` = featured but not wired yet (honest). */
  status: "available" | "coming_soon";
  /** A short, user-facing reason (e.g. why it's coming soon), or null. */
  reason: string | null;
}

/** Slack connection state (#170), from `GET /me/slack`. Never carries the bot token or signing secret. */
export interface SlackStatus {
  connected: boolean;
  fingerprint: string | null;
  teamId?: string | null;
  connectedAt?: string | null;
}

/** Body for `PUT /me/slack` (#170): the bot token + signing secret are write-only. */
export interface SlackConnectInput {
  botToken: string;
  signingSecret: string;
  teamId?: string;
  botUserId?: string;
  slackUserId?: string;
}

/** One external account in the #192 onboarding checklist (`GET /me/external-services`). */
export interface ExternalAccountRequest {
  serviceKey: string;
  displayName: string;
  serviceKind: string;
  reason: string;
  status: "requested" | "connected" | "dismissed";
  connected: boolean;
}

/** The external account onboarding checklist (#192) — what the workspace has filed + connected. */
export interface ExternalAccountsChecklist {
  requests: ExternalAccountRequest[];
  pendingSetupCount: number;
}

/** The real-world readiness summary (#231, `GET /me/realworld`) — what to connect for real work. */
export interface RealworldReadiness {
  enabled: boolean;
  publish?: {
    provider: string;
    live: boolean;
    dryRun: boolean;
  };
  neededAccounts: string[];
}

/** One connectable integration (#258, `GET /me/connections`) — descriptor metadata, never a secret. */
export interface ConnectionView {
  id: string;
  label: string;
  summary: string;
  provider: string;
  kind: string;
  audience: "customer" | "internal";
  auth: "oauth" | "one_click" | "paste_internal";
  status: "available" | "coming_soon" | "blocked";
  statusReason?: string | null;
  capabilities: string[];
  oauthScopes: string[];
  consentStatus: "none" | "recorded";
  providerStatus: "unproven" | "healthy";
  lastProofAt: number | null;
  lastProofReceipt: string | null;
  failureReason: string | null;
  configIssue?: {
    code: string;
    missingEnv: string[];
    remedy: string;
  } | null;
  /** True only when provider proof has passed; consent alone is not connected (#1284). */
  connected: boolean;
}

/** The connections surface (#258): what this workspace can connect + whether it manages internal ones. */
export interface ConnectionsResponse {
  connections: ConnectionView[];
  canManageInternal: boolean;
}

export type ConnectionOAuthStartResponse =
  | {
      status: "pending_approval";
      requestId: string;
      authorizePath?: string;
      provider: string;
      scopes: string[];
      message: string;
    }
  | {
      status: "coming_soon";
      provider: string;
      scopes: string[];
      message: string;
      issue?: {
        code: string;
        missingEnv: string[];
        callbackPath?: string;
      } | null;
    };

export interface GoogleAuthStatus {
  configured: boolean;
  status: "ready" | "maintenance";
  missing: string[];
  issue: "google_oauth_missing_config" | null;
  startPath: string;
  message: string;
  remedy: string | null;
}

export type IMessageSendStatus =
  | "queued"
  | "sent"
  | "dry_run"
  | "disabled"
  | "not_configured"
  | "too_long"
  | "failed";

export interface IMessageRoomResponse {
  status: IMessageSendStatus;
  recipient?: string;
  dryRun: boolean;
  error?: string;
  receipt?: string;
  message?: Message;
}

export interface IMessageRecipientView {
  recipient: string;
  serviceName: string | null;
  verified: boolean;
  verifiedAt: string | null;
}

export interface IMessageRelayJobView {
  id: string;
  workspaceId: string;
  memberId: string | null;
  channelId: string | null;
  messageId: string | null;
  purpose: "verification" | "room" | "notification";
  recipient: string;
  serviceName: string | null;
  text: string;
  receipt: string | null;
  status: "pending" | "claimed" | "sent" | "failed";
  lockedBy: string | null;
  lockedUntil: string | null;
  sentAt: string | null;
  failedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IMessageRelayHeartbeatView {
  relayId: string;
  host: string;
  version: string | null;
  checkedInAt: string;
  messagesAccess: "unknown" | "ok" | "failed";
  messagesDbAccess: "unknown" | "ok" | "failed";
  active: boolean;
}

export interface IMessageRelayInboundReceiptView {
  id: string;
  workspaceId: string;
  memberId: string;
  channelId: string;
  messageId: string;
  replyToMessageId: string;
  sender: string;
  receipt: string;
  text: string;
  createdAt: string;
}

export interface IMessageStatusResponse {
  enabled: boolean;
  configured: boolean;
  dryRun: boolean;
  recipient?: string;
  recipientSource?: "member_verified" | "member_pending" | "workspace" | "none";
  requiresVerification?: boolean;
  maxChars: number;
  memberRecipient: IMessageRecipientView | null;
  lastRelayJob?: IMessageRelayJobView | null;
  relayHeartbeat?: IMessageRelayHeartbeatView | null;
  lastInboundReceipt?: IMessageRelayInboundReceiptView | null;
}

export interface IMessageRecipientSaveResponse {
  status: "pending_verification";
  recipient: string;
  serviceName: string | null;
  verified: false;
  message: string;
}

export interface IMessageTestResponse {
  status: IMessageSendStatus;
  recipient?: string;
  dryRun: boolean;
  error?: string;
  memberRecipient: IMessageRecipientView | null;
}

export type FirstRunStage = "source_read" | "agent_result" | "dashboard_receipt";

export interface FirstRunReceiptDto {
  stage: FirstRunStage;
  target: string;
  finding: string;
  artifactTitle: string;
  artifactSummary: string;
  receipt: string;
  recordedAtMs: number;
}

export interface FirstRunReceiptInput {
  stage?: FirstRunStage;
  target: string;
  finding: string;
  artifactTitle: string;
  artifactSummary: string;
  receipt: string;
}

export interface FirstRunReceiptResponse {
  firstRun: FirstRunReceiptDto | null;
}

/**
 * One department agent as the Agent Garden shows it (#284, `GET /me/garden`) — the sanitized contract
 * projection + this workspace's enable state + the production-grounded `active` flag. Never a secret; every
 * free-text field has already been sanitized server-side (injection defense).
 */
export interface GardenAgentView {
  handle: string;
  displayName: string;
  title: string;
  summary: string;
  capabilities: string[];
  costTier: "low" | "medium" | "high";
  riskTier: "read_only" | "internal_draft" | "external_send";
  /** A coarse pricing label derived from the cost tier (no fabricated number). */
  priceLabel: string;
  /** Whether switching this agent on requires owner approval (the external-send tier). */
  requiresApprovalToEnable: boolean;
  /** Whether the persona is actually seeded in this workspace (the production-grounded fact). */
  present: boolean;
  state: "enabled" | "pending_approval" | "disabled";
  /** The reconciled, real on/off: flag on AND state enabled AND present. */
  active: boolean;
  /** When not active, the honest reason; otherwise null. */
  inactiveReason: string | null;
  /**
   * The owner's EXPLICIT choice for this capability, when one is stored (#760). `undefined` means no choice has
   * been made — the autonomy-by-default policy then presents the capability ON (money stays approval-gated).
   * `"off"` is a persisted opt-out and is always respected. The web resolves the displayed state from this via
   * `resolveGardenDisplay`; it never hardcodes a second default.
   */
  userPreference?: "on" | "off";
}

/** The Agent Garden surface (#284, `GET /me/garden`): whether it can be managed + every agent's view. */
export interface GardenResponse {
  /** True iff this workspace may enable/disable (flag on + owner-first satisfied). Catalog lists regardless. */
  canManage: boolean;
  agents: GardenAgentView[];
}

export type SkillOptProposalStatus = "staged" | "deduped" | "skipped";

/** One SkillOpt-Sleep proposal/outcome row (#1065), from GET /me/skillopt/proposals. */
export interface SkillOptProposalDto {
  id: string;
  runId: string;
  workspaceId: string;
  agentHandle: string;
  skillId: string;
  status: SkillOptProposalStatus;
  skipReason: string | null;
  clusterKey: string | null;
  metric: string | null;
  higherIsBetter: boolean | null;
  baseline: number | null;
  candidate: number | null;
  improvementRatio: number | null;
  sampleSize: number | null;
  externallyVerified: boolean | null;
  currentDocSha: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface SkillOptProposalsResponse {
  proposals: SkillOptProposalDto[];
}

/** The brand kit (#271) — the owner's one-time brand identity the fleet draws from. */
export interface BrandKitDto {
  id: string;
  name: string;
  palette: string[];
  voice: string;
  logoAssetId: string | null;
}

/** `GET/PUT /me/brand-kit` — whether a kit is set, the kit itself, and the live on-brand asset count. */
export interface BrandKitState {
  connected: boolean;
  brandKit: BrandKitDto | null;
  assetCount?: number;
}

/** Body for setting the brand kit from Settings (#271). */
export interface BrandKitInputDto {
  name: string;
  palette: string[];
  voice?: string;
  logoAssetId?: string | null;
}

/** The marketing target (#502) — what the fleet is marketing (the workspace's product OR any external app). */
export interface MarketingTargetDto {
  name: string | null;
  /** The target's website / app URL (stored as the onboarding domain). */
  url: string | null;
  positioning: string | null;
  audience: string | null;
  competitors: string | null;
}

/** `GET/PUT /me/marketing-target` — the stored target, whether it's set, and the brief the fleet reads. */
export interface MarketingTargetState {
  configured: boolean;
  target: MarketingTargetDto;
  /** The exact context preamble a briefed agent receives, so the owner can preview it (null until set). */
  preamble: string | null;
}

/** Body for setting the marketing target from Settings (#502). Every field optional; at least one required. */
export interface MarketingTargetInputDto {
  name?: string;
  url?: string;
  positioning?: string;
  audience?: string;
  competitors?: string;
}

/** Body for connecting an external account from Settings (#231): file the need, then seal the secret. */
export interface ExternalAccountConnectInput {
  serviceKey: string;
  serviceKind: string;
  displayName: string;
  secrets: Record<string, string>;
}

/** Current caller, from `GET /me`. */
export interface Identity {
  workspaceId: string;
  memberId: string;
  kind: MemberKind;
  displayName: string;
}

/** A channel, from `GET/POST /workspaces/:wid/channels` and `/dms`. */
export interface Channel {
  id: string;
  workspaceId: string;
  kind: ChannelKind;
  name: string | null;
  isArchived: boolean;
}

/** A message — REST list/create payload AND the realtime `message` event payload. */
export interface Message {
  id: string;
  channelId: string;
  authorMemberId: string;
  parentMessageId: string | null;
  alsoSentToChannel: boolean;
  body: string;
}

/** Thread view, from `GET /channels/:cid/messages/:mid/thread`. */
export interface ThreadView {
  root: Message;
  replies: Message[];
  replyCount: number;
}

/** A persisted mention row, from `GET /me/mentions`. */
export interface MentionItem {
  id: string;
  messageId: string;
  channelId: string;
  authorMemberId: string;
  body: string;
  createdAt: string;
}

/** A realtime mention event payload (no `createdAt`). */
export interface MentionEvent {
  id: string;
  messageId: string;
  channelId: string;
  mentionedMemberId: string;
  authorMemberId: string;
  body: string;
}

/**
 * A notification pushed to the recipient's sockets (#8) — mirrors the server `NotificationEvent`
 * (`apps/server/src/realtime/protocol.ts`). Delivered to the recipient regardless of channel
 * subscription. `type:"approval"` is the signal a gated action (#13) needs a human decision; the
 * Approvals Panel uses it to refresh the pending queue live. The server already emits this event —
 * the web union simply never listed it (see ADR-0026).
 */
export interface NotificationEvent {
  id: string;
  type: "mention" | "dm" | "reply" | "assignment" | "approval";
  recipientMemberId: string;
  actorMemberId: string | null;
  channelId: string | null;
  messageId: string | null;
  taskId: string | null;
  excerpt: string | null;
  createdAt: string;
}

/** A member search hit, from `GET /workspaces/:wid/search/members`. */
export interface MemberHit {
  id: string;
  kind: MemberKind;
  displayName: string;
}

/** An agent profile, from `GET /workspaces/:wid/agents`. */
export interface AgentProfile {
  id: string;
  name: string;
  framework: string | null;
  ownerUserId: string | null;
  deactivatedAt: string | null;
  createdAt: string;
}

export type TeamRunHarness = "demo" | "claude-code" | "codex";

export interface TeamRunSubtaskInput {
  agentMemberId: string;
  task: string;
  branch: string;
  harness?: TeamRunHarness;
}

export interface TeamRunResponse {
  teamRunId: string;
  subtaskCount: number;
  subtasks: Array<{
    subtaskId: string;
    agentMemberId: string;
    branch: string;
    harness: TeamRunHarness | null;
  }>;
}

export interface CodexSubscriptionStatus {
  connected: boolean;
  reason: string;
  selectedHarness: "codex";
  userAuthenticated: boolean;
  workspaceAuthenticated: boolean;
  runtimeAuth: "signed_in_subscription" | "missing";
  fallback: "none";
  apiKeySatisfies: false;
}

/**
 * The members-rail footer (#371): humans · agents · decisions captured, from `GET /me/department`.
 * `summary` is the server-rendered line; the counts are exposed for the client to re-render if needed.
 */
export interface MembersRailDto {
  humanCount: number;
  agentCount: number;
  decisionsCaptured: number;
  summary: string;
}

/** One teammate in the named-department roster (#371): identity (role + color) + #282 registry presence. */
export interface DepartmentTeammateDto {
  handle: string;
  displayName: string;
  role: string;
  color: string;
  lead: boolean;
  summary: string;
  present: boolean;
  enabled: boolean;
}

/** The named-department view (#371), from `GET /me/department`. The roster, the rail footer + enable flags. */
export interface DepartmentViewDto {
  enabled: boolean;
  canManage: boolean;
  roster: DepartmentTeammateDto[];
  rail: MembersRailDto;
}

/**
 * The classified, human-readable cause of a failed run (#634), present on a session whose status is a
 * terminal failure (else null). Lets the run-status UI show WHY a run stopped + what to do next, so a
 * failure is never silent. Carries only the class + brand-voice copy — never the raw output tail.
 */
export interface SessionFailureDto {
  /** spawn | auth | timeout | budget | canceled | model | overloaded | error. */
  failureClass: string;
  /** One-line "what happened". */
  headline: string;
  /** One-line "what to do next" (retry / reconnect / pick a model …). */
  detail: string;
}

/**
 * A summary of an agent session for the review surface (#51), from `GET /channels/:cid/agent-sessions`.
 * The git refs are set once the session has run in a worktree (null otherwise).
 */
export interface AgentSessionSummary {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: string;
  result: string | null;
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  /** Model/provider selection (#52) the session ran with; null when none was chosen. */
  provider: ProviderKind | null;
  model: string | null;
  effort: EffortLevel | null;
  mode: SessionMode | null;
  createdAt: string;
  /** #634: the classified failure cause when this run failed (else null/absent on older servers). */
  failure?: SessionFailureDto | null;
}

/** Model/provider selection vocabulary (#52) — mirrors the server's selection layer. */
export type ProviderKind = "anthropic" | "openai" | "bedrock" | "vertex" | "custom";
export type EffortLevel = "off" | "low" | "medium" | "high";
export type SessionMode = "single" | "auto";

/** A per-session model/provider selection a launch form collects (#52). */
export interface ModelSelection {
  provider: ProviderKind;
  model: string;
  effort: EffortLevel;
  mode: SessionMode;
}

/** Search envelope shared by all three search endpoints. */
export interface SearchEnvelope<T> {
  query: string;
  limit: number;
  offset: number;
  results: T[];
}

// --- WebSocket protocol (mirrors apps/server/src/realtime/protocol.ts) ----------------------

/** Commands the client sends to the `/ws` gateway. */
export type ClientCommand =
  | { type: "subscribe"; channelId: string }
  | { type: "unsubscribe"; channelId: string }
  | { type: "presence"; status: "online" | "away" }
  | { type: "ping" };

/** Cloud-scale usage report (#71), from `GET /workspaces/:wid/scale/usage`. */
export interface UsageReport {
  /** The billing window (UTC `YYYY-MM`). */
  window: string;
  sessionsStarted: number;
  computeSeconds: number;
  estimatedCostCents: number;
  /** The resolved caps/budget for this tenant (0 = off/unlimited). */
  caps: {
    tenantConcurrency: number;
    budgetCents: number;
    warmPoolSize: number;
    regions: string[];
  };
  /** Live in-flight concurrency: this tenant, the whole fleet, and per region. */
  inFlight: {
    tenant: number;
    global: number;
    byRegion: Record<string, number>;
  };
  /** True when accrued cost has met/passed the budget cap (new launches are halted). */
  overBudget: boolean;
}

/**
 * The maintenance-mode flag (#99), as returned by `GET/POST /maintenance` and embedded in the Founder
 * Console switches. `enabled` is the live state; `unavailable` means the backing store (Redis) couldn't
 * be reached, so the state is unknown and the control is non-interactive.
 */
export interface MaintenanceState {
  enabled: boolean;
  since?: string;
  reason?: string;
  by?: string;
  unavailable?: boolean;
}

/** Result of `POST /workspaces/:wid/autonomy/kill | /resume` (#17): the resolved kill-switch state. */
export interface KillSwitchState {
  ok: boolean;
  killSwitch: boolean;
}

/**
 * The Founder Console roll-up (#104), from `GET /workspaces/:wid/founder-console`. A read-only
 * aggregation: fleet status, the venture pipeline (#96), revenue/willingness-to-pay (#98), budget
 * burn (#71), the pending #13 approval queue (with decision-SLA ages), and the safety switches.
 * Mirrors the server `FounderConsole` shape (kept in lock-step by hand — no codegen).
 */
export interface FounderConsoleDto {
  workspaceId: string;
  generatedAtMs: number;
  fleet: { activeSessions: number; sessionsThisWindow: number; globalInFlight: number };
  venturePipeline: {
    total: number;
    active: number;
    funded: number;
    killed: number;
    /** Borderline calls awaiting human judgment (terminal verdict ESCALATE). */
    escalated: number;
    /** Zero-budget scaffolds (#228): owner-activated ventures that haven't cleared the #96 fundability bar. */
    scaffolds?: number;
  };
  revenue: {
    currency: string;
    totalCents: number;
    paymentCount: number;
    willingnessToPayCount: number;
    hasWillingnessToPay: boolean;
  };
  budget: {
    window: string;
    estimatedCostCents: number;
    budgetCents: number;
    overBudget: boolean;
    /** Spent / cap as a fraction; null when no positive cap is set. */
    utilization: number | null;
  };
  /** The pending #13 queue, oldest-first (longest-waiting = highest priority). */
  pendingApprovals: {
    id: string;
    actionType: string;
    summary: string;
    amount: number | null;
    /** Time in queue, in seconds (the decision SLA). */
    ageSeconds: number;
    createdAtMs: number;
  }[];
  switches: {
    killSwitch: boolean;
    maintenance: MaintenanceState;
  };
  /** Reliability insights (#148): MTTR, frequency, open count, noisiest components. */
  reliability?: {
    mttrMs: number | null;
    incidentsLast7d: number;
    incidentsLast30d: number;
    openCount: number;
    total: number;
    noisiestComponents: { service: string; count: number }[];
  };
  /** Production agent observability (#1292): scheduler, queue, audit coverage, stalls, and recovery. */
  agentObservability?: {
    scheduler: {
      status: "healthy" | "degraded" | "stopped" | "unknown";
      lastTickAgeSeconds: number | null;
    };
    queueDepth: number;
    runningRuns: number;
    stalledRuns: number;
    failedRunsLast24h: number;
    retryRate: number | null;
    recovery: {
      state: "idle" | "retrying" | "needs_human" | "unknown";
      retryableStuckRuns: number;
      lastRecoveryAtMs: number | null;
    };
    audit: {
      toolCalls: number;
      auditedToolCalls: number;
      unauditedToolCalls: number;
      coverage: number | null;
    };
    connectorSilentFailures: {
      connector: string;
      status: "silent" | "failing" | "unknown";
      lastOkAgeSeconds: number | null;
    }[];
    alerts: string[];
  };
  /** The Growth Loop roll-up (#102/#222): event-driven funnel counts (no longer placeholders). */
  growth?: {
    score: number;
    totalEvents: number;
    acquisition: number;
    activation: number;
    conversion: number;
    retention: number;
    topSource: string | null;
    experimentsTotal: number;
    externalPostsSubmitted: number;
  };
  /** The Customer Discovery GTM pipeline (#222): per-stage prospect counts + the PQL count. */
  discoveryPipeline?: {
    pqlCount: number;
    totalProspects: number;
    stages: { stage: string; prospects: number; verifiedProspects: number }[];
  };
  /** The outreach engine (#225): experiments running + EXTERNAL receipts + the gated send queue. */
  outreach?: {
    experimentsRunning: number;
    experimentsConcluded: number;
    messagesPendingApproval: number;
    messagesSent: number;
    replies: number;
    meetings: number;
    signups: number;
  };
  /** Per-artifact attributed revenue (#868), computed from verified payment receipts. */
  attribution?: {
    totalAttributedCents: number;
    attributedPaymentCount: number;
    unattributedPaymentCount: number;
    topArtifacts: {
      artifactId: string;
      artifactKind: string;
      channel: string;
      attributedCents: number;
      currency: string;
      paymentCount: number;
    }[];
  };
  /**
   * The per-department PROOF scorecard (#253): one tile per marketing department with a real, sourced outcome
   * metric + trend — or "not connected" where a source isn't wired yet. Optional only for backward-compat with
   * older payloads; the live server always sends it (all seven tiles).
   */
  proofScorecard?: {
    connectedCount: number;
    total: number;
    tiles: {
      department: string;
      agent: string;
      title: string;
      metricLabel: string;
      connection: "connected" | "not_connected";
      unit: "count" | "currency" | "ratio_bps";
      value: number | null;
      display: string;
      trend: "up" | "down" | "flat" | "none";
      delta: number | null;
      improving: boolean | null;
      trendDetail: string;
      source: string;
      note: string | null;
      evidenceKind: "live" | "sample" | "dogfood" | "external_customer_proof";
      receipt: { kind: "signup" | "payment" | "reply" | "call_booked" | "customer_approval"; ref: string } | null;
    }[];
  };
  /** Whether the platform needs a human right now, and why. */
  attention: { required: boolean; reasons: string[] };
}

/** Captured inbound lead lifecycle (#898), from `GET /me/inbound/leads`. */
export type InboundLeadStatus = "new" | "working" | "converted" | "archived";

export interface InboundLeadDto {
  id: string;
  workspaceId: string;
  name: string | null;
  email: string;
  message: string;
  source: string;
  trackingRef: string | null;
  status: InboundLeadStatus;
  assigneeMemberId: string | null;
  nextAction: string | null;
  respondedAtMs: number | null;
  slaDueAtMs: number;
  slaNotifiedAtMs: number | null;
  slaBreached: boolean;
  reachContactKey: string;
  createdAtMs: number;
}

export interface InboundLeadsResponse {
  leads: InboundLeadDto[];
}

export interface InboundLeadUpdateInput {
  status?: InboundLeadStatus;
  assigneeMemberId?: string | null;
  nextAction?: string | null;
  respondedAt?: string | null;
}

/** One owner-decision in the unified queue (#173): approval / guardrail escalation / constitution. */
export interface DecisionQueueItemDto {
  kind: "approval" | "guardrail_escalation" | "constitution";
  id: string;
  title: string;
  impact: "critical" | "high" | "normal";
  ageSeconds: number;
  escalationLevel: number;
  createdAtMs: number;
  link: string | null;
}

/** The unified decision queue (#173): one ordered list with age + impact + escalation. */
export interface DecisionQueueDto {
  workspaceId: string;
  generatedAtMs: number;
  items: DecisionQueueItemDto[];
  total: number;
  byImpact: { critical: number; high: number; normal: number };
  stale: number;
  critical: number;
}

/** The daily brief (#173): what shipped, what's blocked, decisions waiting, spend, constitution. */
export interface DailyBriefDto {
  workspaceId: string;
  generatedAtMs: number;
  shipped: { title: string; ref: string | null }[];
  blocked: { title: string; reason: string; ref: string | null }[];
  decisionsWaiting: DecisionQueueItemDto[];
  spend: {
    estimatedCostCents: number;
    budgetCents: number;
    currency: string;
    overBudget: boolean;
    utilization: number | null;
  };
  constitution: { open: number; topCodes: string[] };
  /** The brand-voice brief (< 200 words). */
  text: string;
  wordCount: number;
}

/**
 * The intake artifact the owner briefs to start ANY company (#387) — POSTed to the already-built #96
 * venture loop's `POST /workspaces/:wid/ventures`. Product-agnostic: nothing marketing-specific. All five
 * core fields are required by the server; `segment` is the optional #146 go-to-market signal.
 */
export interface VentureIdeaInput {
  problem: string;
  targetUser: string;
  insight: string;
  wedge: string;
  marketPath: string;
  segment?: "b2b" | "b2c" | null;
}

/** The persisted idea the venture submit route returns (201). The web shows its id + status on success. */
export interface VentureIdeaDto {
  id: string;
  workspaceId: string;
  problem: string;
  targetUser: string;
  insight: string;
  wedge: string;
  marketPath: string;
  segment: "b2b" | "b2c" | null;
  status: string;
  epicTaskId: string | null;
  createdByMemberId: string | null;
}

/** One per-venture P&L row in the weekly founder report (#173). */
export interface VenturePnLDto {
  ideaId: string;
  status: string;
  decision: string | null;
  currentScore: number | null;
  previousScore: number | null;
  scoreDelta: number | null;
  revenueCents: number | null;
  costCents: number | null;
  netCents: number | null;
  marginPct: number | null;
  hasPnl: boolean;
}

/** The weekly founder report (#173): per-venture P&L + recommendations + voice + backlog. */
export interface WeeklyReportDto {
  workspaceId: string;
  generatedAtMs: number;
  currency: string;
  revenueTotalCents: number;
  ventures: VenturePnLDto[];
  recommendations: { doubleDown: number; maintain: number; pivot: number; sunset: number };
  voiceSignals: { summary: string; sentiment: string; churnRisk: string }[];
  backlog: { title: string; score: number; position: number }[];
  text: string;
  wordCount: number;
}

/** The public status page payload (#148): component health + a redacted incident history. */
export type StatusLevel = "operational" | "degraded" | "major_outage";
export interface StatusPageDto {
  workspaceName: string;
  overall: StatusLevel;
  components: { name: string; status: StatusLevel }[];
  incidents: {
    title: string;
    service: string;
    severity: "warning" | "critical";
    status: "firing" | "escalated" | "resolved";
    openedAt: string;
    resolvedAt: string | null;
  }[];
  generatedAt: string;
}

export type PublicDogfoodPhase =
  | "thinking"
  | "tool"
  | "artifact"
  | "approval"
  | "outcome"
  | "blocked";

export interface PublicDogfoodReceiptDto {
  id: string;
  agent: string;
  workstream: string;
  phase: PublicDogfoodPhase;
  summary: string;
  artifactLabel: string | null;
  approvalStatus: string | null;
  occurredAt: string;
}

export interface PublicDogfoodFeedDto {
  slug: string;
  workspaceName: string;
  title: string;
  lastUpdatedAt: string | null;
  receipts: PublicDogfoodReceiptDto[];
}

export interface PublicSupportTicketStatusDto {
  ticketId: string;
  status: "open" | "triaged" | "awaiting_approval" | "replied" | "closed";
  subject: string | null;
  channel: string;
  createdAt: string;
  updatedAt: string;
  firstResponseSlaMinutes: number;
  slaDueAt: string;
  slaBreached: boolean;
  responseState: "waiting" | "reply_pending_approval" | "replied" | "closed";
  events: { type: string; at: string; detail: string | null }[];
}

/** Events the `/ws` gateway sends to the client. */
export type ServerEvent =
  | { type: "ready"; memberId: string; workspaceId: string }
  | { type: "subscribed"; channelId: string }
  | { type: "unsubscribed"; channelId: string }
  | { type: "message"; message: Message }
  | { type: "mention"; mention: MentionEvent }
  | { type: "notification"; notification: NotificationEvent }
  | { type: "presence"; memberId: string; status: PresenceStatus }
  | { type: "pull_request"; pullRequest: PullRequestDto }
  | { type: "review_comment"; comment: ReviewCommentDto }
  | {
      type: "run_status";
      sessionId: string;
      channelId: string;
      status: RunStatus;
      url?: string | null;
      exitCode?: number | null;
      error?: string | null;
    }
  | { type: "run_log"; sessionId: string; channelId: string; chunk: string }
  | {
      type: "deploy_status";
      sessionId: string;
      channelId: string;
      deploymentId: string;
      status: DeployStatus;
      url?: string | null;
      error?: string | null;
    }
  | {
      type: "deploy_log";
      sessionId: string;
      channelId: string;
      deploymentId: string;
      chunk: string;
    }
  | { type: "error"; code: "forbidden" | "bad_request" | "not_found"; detail?: string }
  | { type: "pong" };

// ---- Ona-class agent infrastructure (#147) ------------------------------------------------------

/** A schedule cadence spec for an automation (mirrors the server `ScheduleSpec`). */
export interface ScheduleSpecDto {
  cadence: "interval" | "hourly" | "daily" | "weekly";
  everyMinutes?: number;
  dayOfWeek?: number;
  hour?: number;
  minute?: number;
}

/** An automation definition, from `GET /workspaces/:wid/automations`. */
export interface AutomationDto {
  id: string;
  workspaceId: string;
  name: string;
  triggerKind: "schedule" | "webhook";
  schedule: ScheduleSpecDto | null;
  templateKey: string;
  params: Record<string, string>;
  channelId: string;
  agentHandle: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Returned ONCE on create for a webhook trigger (the bearer token). */
  webhookToken?: string;
}

/** A run-ledger row, from `POST .../run` and the audit feed. */
export interface AutomationRunDto {
  id: string;
  automationId: string;
  trigger: "schedule" | "webhook" | "manual";
  status: "launched" | "skipped" | "blocked" | "failed";
  reason: string;
  sessionId: string | null;
  task: string;
  createdAt: string;
}

/** A workspace catalog entry (#152): a registered marketing asset. */
export interface CatalogEntryDto {
  id: string;
  workspaceId: string;
  kind: string;
  name: string;
  identifier: string;
  status: "active" | "inactive" | "pending" | "archived";
  provenance: "manual" | "synced" | "agent";
  ownerMemberId: string | null;
  metadata: Record<string, string>;
  createdByMemberId: string;
  createdAt: string;
  updatedAt: string;
}

/** A workflow definition (#152): a trigger → conditions → actions chain. */
export interface WorkflowDto {
  id: string;
  workspaceId: string;
  name: string;
  triggerKind: "schedule" | "webhook" | "catalog_change" | "channel_event";
  trigger: Record<string, unknown>;
  conditions: { fact: string; op: string; value?: string | number | boolean }[];
  actions: Record<string, unknown>[];
  enabled: boolean;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Returned ONCE on create for a webhook trigger (the bearer token). */
  webhookToken?: string;
}

/** A workflow run-ledger row (#152), from `POST .../run` and the ledger feed. */
export interface WorkflowRunDto {
  id: string;
  workflowId: string;
  trigger: "schedule" | "webhook" | "catalog_change" | "channel_event" | "manual";
  status: "fired" | "skipped" | "blocked" | "failed";
  reason: string;
  results: { kind: string; status: string; reason: string; ref?: string }[];
  createdAt: string;
}

/** The run-history insights (#152): the console success/failure trend. */
export interface WorkflowInsightsDto {
  total: number;
  byStatus: { fired: number; skipped: number; blocked: number; failed: number };
  successRate: number;
  recentFailureReasons: string[];
  daily: { date: string; fired: number; failed: number; blocked: number }[];
}

/** A task-template gallery entry; `agentHandle` is attached when fetched for a channel. */
export interface TaskTemplateDto {
  key: string;
  department: string;
  title: string;
  description: string;
  body: string;
  params: { key: string; label: string; placeholder: string }[];
  agentHandle?: string;
}

/** One normalized audit event, from `GET /workspaces/:wid/audit`. */
export interface AuditEventDto {
  at: string;
  kind: string;
  source: "approval" | "automation" | "agent" | "credential";
  actorMemberId: string | null;
  actorLabel: string;
  summary: string;
  gatedBy: "approval" | "venture+budget" | "none";
  status: string;
  ref: string;
}

/** A live session row, from `GET /workspaces/:wid/mission-control`. */
export type AgentActivityStatus = "thinking" | "drafting" | "waiting" | "handoff" | "idle" | "done";

export interface LiveSessionDto {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: string;
  /** What the agent is doing now (#1050), separate from lifecycle status. */
  agentStatus: AgentActivityStatus;
  elapsedMs: number;
  estimatedCostCents: number;
  startedAt: string | null;
  progressAt: string;
}

/** Why nothing is running, classified server-side (#230) so the console never sits on "hang tight". */
export type DiagnosticState = "running" | "sessions_failing" | "no_venture" | "no_work" | "idle";

export interface MissionDiagnosticDto {
  state: DiagnosticState;
  /** Human, brand-voice headline the console shows in place of "hang tight". */
  headline: string;
  /** One line on what to do next. */
  detail: string;
  /** The failure class behind a `sessions_failing` state (else null). */
  dominantFailureClass: string | null;
  liveCount: number;
  recentFailureCount: number;
}

/** A recently-failed session surfaced with its classified exit reason (#230). */
export interface RecentFailureDto {
  id: string;
  channelId: string;
  agentMemberId: string;
  status: string;
  exitCode: number | null;
  failureClass: string;
  headline: string;
  detail: string;
  endedAtMs: number | null;
}

/** Recent terminal-session reliability counters from mission-control (#394). */
export interface MissionFailureBreakdownDto {
  total: number;
  succeeded: number;
  failed: number;
  failureRate: number;
  byClass: Partial<Record<string, number>>;
  dominantClass: string | null;
}

/** One persisted event in an agent run's append-only trace (#664). */
export interface AgentTraceEventDto {
  id: string;
  runId: string;
  seq: number;
  type: "model_request" | "model_response" | "tool_call" | "tool_result" | "approval_decision";
  turn: number;
  label: string | null;
  payload: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
  occurredAt: string;
}

/** Header for one persisted trace run (#664). */
export interface AgentTraceRunDto {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  agentMemberId: string | null;
  taskId: string | null;
  label: string | null;
  status: "open" | "closed";
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  startedAt: string;
  endedAt: string | null;
}

/** The complete, replay-ordered trace for one run (#664). */
export interface AgentTraceDto {
  run: AgentTraceRunDto;
  events: AgentTraceEventDto[];
}

/** The live mission-control roll-up. */
export interface MissionControlDto {
  sessions: LiveSessionDto[];
  count: number;
  totalEstimatedCostCents: number;
  rateCentsPerMinute: number;
  costIsEstimate: true;
  /** #230 "why is nothing running?" diagnostic — present on current servers, optional for back-compat. */
  diagnostic?: MissionDiagnosticDto;
  /** #230 recently-failed sessions with exit reasons — so a spawn-and-die fleet is visible, not silent. */
  recentFailures?: RecentFailureDto[];
  /** #394 per-class failure rate for the recent terminal-session window. */
  failureBreakdown?: MissionFailureBreakdownDto;
}

// --- marketing site (CMS-lite, #153) ---

/** An inline run inside a rendered markdown block. */
export type SiteInline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "link"; text: string; href: string };

/** A rendered markdown block (the server renders to typed blocks — no HTML, so no XSS). */
export type SiteBlock =
  | { type: "heading"; level: 1 | 2 | 3; inline: SiteInline[] }
  | { type: "paragraph"; inline: SiteInline[] }
  | { type: "list"; ordered: boolean; items: SiteInline[][] }
  | { type: "quote"; inline: SiteInline[] }
  | { type: "code"; text: string }
  | { type: "table"; header: SiteInline[][]; rows: SiteInline[][][] };

/** A content document's metadata (list view). */
export interface SiteDocMeta {
  section: string;
  slug: string;
  title: string;
  description: string;
  kind: string;
  agent: string;
  date: string;
  status: "draft" | "published";
  meta: Record<string, string | string[]>;
}

/** A full content document: metadata plus the rendered body blocks. */
export interface SiteDocDetail extends SiteDocMeta {
  blocks: SiteBlock[];
}

/** The result of seeding a workspace's founding-team department fleet (#123/#138 — the first-run seam). */
export interface DepartmentSeedResult {
  channels: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; agentMemberId: string; handle: string; department: string }>;
  welcomeTasks: Array<{ id: string }>;
  /** The workspace's first venture (#221), present once activation has run; `created` only on first stand-up. */
  venture?: { ideaId: string; created: boolean };
}

/**
 * The result of an owner BRIEF (#235): the lead the goal went to and the REAL sessions it launched down the
 * audited @mention path. `launched` is non-empty when sessions spawned; `connectPrompted` is non-empty when
 * the lead is ready but the workspace has no Claude connected (so it posted a connect prompt instead).
 */
export interface DepartmentBriefResult {
  lead: string;
  department: string;
  channelId: string;
  messageId: string;
  launched: Array<{
    personaId: string;
    handle: string;
    department: string;
    sessionId: string;
    taskId: string;
  }>;
  connectPrompted: Array<{
    personaId: string;
    handle: string;
    department: string;
    messageId: string;
  }>;
}

/** A deliverable card in the #300 read-only sample workspace. */
export interface SampleDeliverableDto {
  id: string;
  agent: string;
  department: string;
  title: string;
  preview: string;
  body: string;
}

/** The #300 read-only sample workspace payload (a demo, never a real tenant). */
export interface SampleConsoleDto {
  readOnly: true;
  workspaceLabel: string;
  deliverables: SampleDeliverableDto[];
}

/** The `GET /sample/console` response — `offered:false` when the front-door flag is OFF (default). */
export interface SampleConsoleResponse {
  offered: boolean;
  console: SampleConsoleDto | null;
}

/** A workspace's live spend position against its global cap (#670). All amounts are cents. */
export interface BudgetStatusDto {
  capCents: number;
  committedCents: number;
  projectedCents: number;
  totalCents: number;
  availableCents: number;
  /** Utilization in basis points (0–10000). */
  utilizationBps: number;
  /** True once committed+projected reach the cap — further spend is halted. */
  halted: boolean;
  /** True once utilization crosses the alert threshold. */
  alerting: boolean;
}

/** A request to raise a workspace's spend cap, pending an explicit human approval (#670). */
export interface CapRaiseDto {
  id: string;
  workspaceId: string;
  fromCents: number;
  toCents: number;
  status: "pending" | "approved" | "rejected";
  requestedByMemberId: string;
  requestedAt: string;
  decidedByMemberId: string | null;
  decidedAt: string | null;
  reason: string | null;
}

/** The `GET /workspaces/:wid/budget` response (#670). */
export interface BudgetResponse {
  enabled: boolean;
  status: BudgetStatusDto;
  pendingRaises: CapRaiseDto[];
}
