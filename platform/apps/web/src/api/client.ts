/**
 * Typed REST client for the Reload server. Every call is same-origin (the Vite dev proxy and the
 * production deployment both serve the app from the API origin), so the httpOnly `rid` session
 * cookie rides along automatically — we just set `credentials: "include"` to be explicit.
 */
import type {
  ApprovalEventDto,
  ApprovalPolicyDto,
  ApprovalRequestDto,
  BillingInvoiceDto,
  BillingInvoicesResponseDto,
  BillingStatusDto,
  CheckoutResponseDto,
  CheckRunDto,
  ChecksStatus,
  DeploymentDto,
  DiffMode,
  PolicySimulationInput,
  PolicySimulationResult,
  PlansResponseDto,
  PreviewAnnotation,
  PullRequestDto,
  ReviewCommentDto,
  RunState,
  SessionDiff,
  SubmitActionResponse,
  VersionResponse,
} from "@reload/shared";
import type {
  AgentProfile,
  AgentSessionSummary,
  DepartmentViewDto,
  AuditEventDto,
  BudgetResponse,
  BudgetStatusDto,
  CapRaiseDto,
  AutomationDto,
  AutomationRunDto,
  CatalogEntryDto,
  WorkflowDto,
  WorkflowRunDto,
  WorkflowInsightsDto,
  Channel,
  CredentialStatus,
  AgentModels,
  ClaudeConnectOffer,
  ClaudeConnectionHealth,
  DepartmentBriefResult,
  DepartmentSeedResult,
  EffortLevel,
  FounderConsoleDto,
  InboundLeadDto,
  InboundLeadsResponse,
  InboundLeadStatus,
  InboundLeadUpdateInput,
  DailyBriefDto,
  WeeklyReportDto,
  VentureIdeaInput,
  VentureIdeaDto,
  DecisionQueueDto,
  Identity,
  KillSwitchState,
  MaintenanceState,
  MemberHit,
  MentionItem,
  Message,
  MissionControlDto,
  ProviderKind,
  AgentTraceDto,
  SearchEnvelope,
  SessionMode,
  SlackStatus,
  SlackConnectInput,
  ExternalAccountsChecklist,
  RealworldReadiness,
  BrandKitState,
  BrandKitInputDto,
  MarketingTargetState,
  MarketingTargetInputDto,
  ExternalAccountConnectInput,
  ConnectionsResponse,
  ConnectionOAuthStartResponse,
  GoogleAuthStatus,
  IMessageRecipientSaveResponse,
  IMessageStatusResponse,
  IMessageTestResponse,
  IMessageRoomResponse,
  FirstRunReceiptInput,
  FirstRunReceiptResponse,
  GardenResponse,
  SkillOptProposalsResponse,
  SkillOptProposalStatus,
  SampleConsoleResponse,
  StatusPageDto,
  PublicSupportTicketStatusDto,
  PublicDogfoodFeedDto,
  TaskTemplateDto,
  SiteDocDetail,
  SiteDocMeta,
  TeamRunResponse,
  TeamRunSubtaskInput,
  CodexSubscriptionStatus,
  ThreadView,
  UsageReport,
} from "./types.js";
import { apiUrl } from "./config.js";

/** Body accepted by `POST /channels/:cid/agent-sessions/:id/review-comments`. */
export interface AddReviewCommentInput {
  filePath: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  body: string;
  pullRequestId?: string;
}

/** Body accepted by `POST /channels/:cid/agent-sessions/:id/pull-request`. */
export interface CreatePrInput {
  title: string;
  body?: string;
  draft?: boolean;
}

/**
 * Body accepted by `POST /channels/:cid/agent-sessions` (#52). `task` is required; the model/provider
 * selection is optional — omit it to run on the deployment/tenant default. The server validates the
 * selection against the tenant's policy and rejects a disallowed choice with a 400 (ApiError).
 */
export interface LaunchSessionInput {
  agentMemberId: string;
  task: string;
  provider?: ProviderKind;
  model?: string;
  effort?: EffortLevel;
  mode?: SessionMode;
}

/** The 202 launch acknowledgement, echoing the resolved (non-secret) selection. */
export interface LaunchSessionResult {
  id: string;
  status: string;
  runtime: string;
  agentMemberId: string;
  provider: ProviderKind | null;
  model: string | null;
  effort: EffortLevel | null;
  mode: SessionMode | null;
}

/** Result of `POST /approvals/:rid/approve` on success (executor ran). */
export interface ApproveResult {
  status: "executed";
  result: Record<string, unknown>;
  request: ApprovalRequestDto;
}

/** Result of `POST /approvals/:rid/reject` on success. */
export interface RejectResult {
  status: "rejected";
  request: ApprovalRequestDto;
}

/** Body accepted by `POST /workspaces/:wid/approval-policies`. */
export interface UpsertPolicyInput {
  actionType: string;
  requireApproval?: boolean;
  maxAutoAmount?: number | null;
}

/** Body accepted by `POST /workspaces/:wid/actions`. */
export interface SubmitActionInput {
  actionType: string;
  payload: Record<string, unknown>;
  amount?: number | null;
  ttlSeconds?: number;
}

/**
 * Error thrown for any non-2xx response, carrying the server's `error` string and HTTP status.
 * A `status` of {@link API_UNAVAILABLE_STATUS} (0) is a synthetic code meaning the API origin
 * couldn't be reached / didn't answer with JSON — see {@link isApiUnavailable}.
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * Seconds the server asked us to wait before retrying, parsed from the `Retry-After` header (#221).
   * Present on a 429 capacity denial so the UI can show an honest "retry in Ns" and hold the retry control
   * until then instead of re-firing straight back into the rate limit. Undefined when no header was sent.
   */
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Synthetic status for "no backend": fetch rejected, or a 2xx response that isn't JSON. */
export const API_UNAVAILABLE_STATUS = 0;

/**
 * True when an error means the API origin is unreachable or not actually serving the API — e.g. the
 * console is deployed standalone (Vercel SPA) and the rewrite returns `index.html` for `/me`. The
 * UI uses this to show a friendly "API not connected" state instead of crashing on bad data (#108).
 */
export function isApiUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === API_UNAVAILABLE_STATUS;
}

/**
 * True when an error is an admission denial — a tenant cap was hit (#71): a budget ceiling (402) or a
 * concurrency/capacity limit (429). The trial funnel (#153) uses this to surface the soft paywall nudge
 * (→ pricing) instead of a raw error, so a hit cap reads as "time for more runway", not "something broke".
 */
export function isCapHit(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 402 || err.status === 429);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      credentials: "include",
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // Network-level failure (DNS, CORS, refused connection): the API is simply not reachable.
    throw new ApiError("API not connected", API_UNAVAILABLE_STATUS);
  }

  let payload: unknown = undefined;
  let parsedJson = false;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
      parsedJson = true;
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `request failed (${res.status})`;
    // #221: surface the server's `Retry-After` (whole seconds) so a rate-limited caller can hold its retry.
    const retryAfterRaw = Number(res.headers.get("retry-after"));
    const retryAfterSeconds =
      Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : undefined;
    throw new ApiError(message, res.status, retryAfterSeconds);
  }

  // A 2xx whose body isn't JSON is not our API answering — almost always the SPA `index.html`
  // served because no backend is wired at this origin. Reject it so callers never receive a string
  // where they expect typed data (which previously crashed components like `channels.filter`).
  if (text && !parsedJson) {
    throw new ApiError("API not connected", API_UNAVAILABLE_STATUS);
  }
  return payload as T;
}

function post(path: string, body?: unknown): Promise<unknown> {
  return request(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function del(path: string): Promise<unknown> {
  return request(path, { method: "DELETE" });
}

function patch(path: string, body?: unknown): Promise<unknown> {
  return request(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Query flag the hosted checkout appends when sending a paid customer back into the app. */
export const CHECKOUT_RETURN_PARAM = "checkout";

/**
 * Where the hosted checkout returns the customer after a successful payment: the current app origin tagged
 * `?checkout=success`, so the SPA can refetch the plan and confirm the upgrade on return. Falls back to a
 * relative path when there's no `window` (tests/SSR).
 */
export function checkoutReturnUrl(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/?${CHECKOUT_RETURN_PARAM}=success`;
}

/**
 * The #260 onboarding entry: the absolute URL the browser navigates to (full page, not fetch) to begin the
 * single Google consent for a typed domain. Goes to the API origin so the OAuth redirect/callback land on
 * the server that holds the session cookie.
 */
export function googleStartUrl(domain: string): string {
  const params = new URLSearchParams({ domain });
  if (typeof window !== "undefined") {
    const current = new URLSearchParams(window.location.search);
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "source", "ref"]) {
      const value = current.get(key);
      if (value) params.set(key, value);
    }
  }
  return apiUrl(`/auth/google/start?${params.toString()}`);
}

export const api = {
  // --- auth ---
  signup(input: {
    email: string;
    password: string;
    displayName: string;
    workspaceSlug?: string;
    source?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    trackingRef?: string;
    termsAccepted?: boolean;
    legalConsentVersion?: string;
    legalConsentAt?: string;
  }): Promise<{ ok: true }> {
    const enriched = { ...input };
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      enriched.source ??= params.get("source") ?? params.get("utm_source") ?? undefined;
      enriched.utmSource ??= params.get("utm_source") ?? undefined;
      enriched.utmMedium ??= params.get("utm_medium") ?? undefined;
      enriched.utmCampaign ??= params.get("utm_campaign") ?? undefined;
      enriched.trackingRef ??= params.get("ref") ?? undefined;
    }
    return post("/auth/signup", enriched) as Promise<{ ok: true }>;
  },
  login(email: string, password: string): Promise<{ ok: true }> {
    return post("/auth/login", { email, password }) as Promise<{ ok: true }>;
  },
  logout(): Promise<{ ok: true }> {
    return post("/auth/logout") as Promise<{ ok: true }>;
  },
  me(): Promise<Identity> {
    return request<Identity>("/me");
  },
  // #366 deploy freshness: the git SHA baked into the running API image (`GET /version`, #292). The web
  // compares it against its own build stamp (VITE_RELOAD_BUILD_SHA) so a stale bundle vs a newer API (or
  // vice-versa) is detectable. Unauthenticated + tenant-agnostic — safe to call before/without a session.
  getVersion(): Promise<VersionResponse> {
    return request<VersionResponse>("/version");
  },
  // #300 low-commitment front door: the read-only sample workspace. UNauthenticated; `offered:false` when
  // the deployment hasn't turned the flag on (default), so the web hides the entry honestly.
  getSampleConsole(): Promise<SampleConsoleResponse> {
    return request<SampleConsoleResponse>("/sample/console");
  },
  getGoogleAuthStatus(): Promise<GoogleAuthStatus> {
    return request<GoogleAuthStatus>("/auth/google/status");
  },

  // --- Connect Claude credentials (#68) ---
  getAgentCredentials(): Promise<CredentialStatus> {
    return request<CredentialStatus>("/me/agent-credentials");
  },
  connectAgentCredentials(token: string): Promise<CredentialStatus> {
    return request<CredentialStatus>("/me/agent-credentials", {
      method: "PUT",
      body: JSON.stringify({ token }),
    });
  },
  disconnectAgentCredentials(): Promise<CredentialStatus> {
    return del("/me/agent-credentials") as Promise<CredentialStatus>;
  },
  // #262: the in-app one-click Connect Claude flow (replaces the `claude setup-token` CLI).
  getClaudeConnectOffer(): Promise<{ offer: ClaudeConnectOffer }> {
    return request<{ offer: ClaudeConnectOffer }>("/me/claude/connect");
  },
  startClaudeConnect(): Promise<{ authorizeUrl: string }> {
    return request<{ authorizeUrl: string }>("/me/claude/connect/start", { method: "POST" });
  },
  // #365: the connection-health signal — connected / not connected / token expired — for the at-a-glance chip.
  getClaudeHealth(): Promise<{ health: ClaudeConnectionHealth }> {
    return request<{ health: ClaudeConnectionHealth }>("/me/claude/health");
  },
  // #246: the owner model picker — list the selectable models + set/clear the workspace's fleet model.
  getAgentModels(): Promise<AgentModels> {
    return request<AgentModels>("/me/agent-models");
  },
  setAgentModel(model: string | null): Promise<CredentialStatus> {
    return request<CredentialStatus>("/me/agent-model", {
      method: "PUT",
      body: JSON.stringify({ model }),
    });
  },

  // --- Connect Slack (#170): the per-tenant Slack app vault (token write-only) ---
  getSlack(): Promise<SlackStatus> {
    return request<SlackStatus>("/me/slack");
  },
  connectSlack(input: SlackConnectInput): Promise<SlackStatus> {
    return request<SlackStatus>("/me/slack", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  disconnectSlack(): Promise<SlackStatus> {
    return del("/me/slack") as Promise<SlackStatus>;
  },

  // --- Connect external accounts (#192/#231): the venture-operating accounts the fleet acts through ---
  getExternalAccounts(): Promise<ExternalAccountsChecklist> {
    return request<ExternalAccountsChecklist>("/me/external-services");
  },
  getRealworldReadiness(): Promise<RealworldReadiness> {
    return request<RealworldReadiness>("/me/realworld");
  },
  // File the need (so the checklist records the kind), then seal the secret — both gated by onboarding.
  async connectExternalAccount(
    input: ExternalAccountConnectInput,
  ): Promise<ExternalAccountsChecklist> {
    await post("/me/external-services", {
      required: [
        {
          serviceKey: input.serviceKey,
          serviceKind: input.serviceKind,
          displayName: input.displayName,
          reason: "Connected by the owner from Settings",
        },
      ],
    });
    await request(`/me/external-credentials/${encodeURIComponent(input.serviceKey)}`, {
      method: "PUT",
      body: JSON.stringify({ secrets: input.secrets }),
    });
    return this.getExternalAccounts();
  },
  async disconnectExternalAccount(serviceKey: string): Promise<ExternalAccountsChecklist> {
    await del(`/me/external-credentials/${encodeURIComponent(serviceKey)}`);
    return this.getExternalAccounts();
  },

  // --- Connections (#258): the OAuth-first "connect once, the agents do the rest" surface ---
  getConnections(): Promise<ConnectionsResponse> {
    return request<ConnectionsResponse>("/me/connections");
  },
  // Internal/admin paste connect (the GitHub site-publish connection). Owner-gated on the server.
  async connectInternal(
    id: string,
    input: { repo: string; token: string; baseBranch?: string },
  ): Promise<ConnectionsResponse> {
    await request(`/me/connections/${encodeURIComponent(id)}/connect`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return this.getConnections();
  },
  async disconnectConnection(id: string): Promise<ConnectionsResponse> {
    await del(`/me/connections/${encodeURIComponent(id)}`);
    return this.getConnections();
  },
  // One-click customer consent (#529/#507) — turn on a live channel (e.g. outbound email). No redirect, no
  // pasted secret; the server seals an empty-secret connected row. Re-read the full surface for the caller.
  async enableConnection(id: string): Promise<ConnectionsResponse> {
    await post(`/me/connections/${encodeURIComponent(id)}/enable`);
    return this.getConnections();
  },
  // Join the waitlist (#507) for a connector that isn't live yet — a clear next step instead of a dead stop.
  async joinConnectionWaitlist(id: string): Promise<void> {
    await request(`/me/connections/${encodeURIComponent(id)}/waitlist`, { method: "POST" });
  },
  // Begin a consumer-OAuth connect. Unwired providers reply 501 "coming soon"; live providers park consent.
  startConnectionOAuth(id: string): Promise<ConnectionOAuthStartResponse> {
    return request<ConnectionOAuthStartResponse>(`/me/connections/${encodeURIComponent(id)}/oauth/start`, { method: "POST" });
  },
  getIMessageStatus(): Promise<IMessageStatusResponse> {
    return request<IMessageStatusResponse>("/me/imessage/status");
  },
  saveIMessageRecipient(input: { recipient: string; serviceName?: string }): Promise<IMessageRecipientSaveResponse> {
    return request<IMessageRecipientSaveResponse>("/me/imessage/recipient", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  async deleteIMessageRecipient(): Promise<void> {
    await del("/me/imessage/recipient");
  },
  testIMessageRecipient(text?: string): Promise<IMessageTestResponse> {
    return request<IMessageTestResponse>("/me/imessage/test", {
      method: "POST",
      body: JSON.stringify(text ? { text } : {}),
    });
  },
  startIMessageRoom(channelId: string, text: string): Promise<IMessageRoomResponse> {
    return request<IMessageRoomResponse>(
      `/channels/${encodeURIComponent(channelId)}/imessage/room`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    );
  },

  getFirstRunReceipt(): Promise<FirstRunReceiptResponse> {
    return request<FirstRunReceiptResponse>("/me/onboarding/first-run");
  },
  recordFirstRunReceipt(input: FirstRunReceiptInput): Promise<FirstRunReceiptResponse> {
    return post("/me/onboarding/first-run", input) as Promise<FirstRunReceiptResponse>;
  },

  // --- Agent Garden (#284): browse the department fleet + enable/disable each agent per workspace ---
  getGarden(): Promise<GardenResponse> {
    return request<GardenResponse>("/me/garden");
  },
  // Switch an agent on. An external-send agent parks an owner approval (202) instead of enabling directly;
  // either way the server returns the refreshed surface in `garden`, which we hand back to the panel.
  async enableGardenAgent(handle: string): Promise<GardenResponse> {
    const res = await post(`/me/garden/${encodeURIComponent(handle)}/enable`);
    return (res as { garden: GardenResponse }).garden;
  },
  async disableGardenAgent(handle: string): Promise<GardenResponse> {
    const res = await post(`/me/garden/${encodeURIComponent(handle)}/disable`);
    return (res as { garden: GardenResponse }).garden;
  },

  // --- SkillOpt-Sleep proposals (#1065): staged edits + held-out validation receipts ---
  skillopt: {
    proposals(status?: SkillOptProposalStatus): Promise<SkillOptProposalsResponse> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<SkillOptProposalsResponse>(`/me/skillopt/proposals${qs}`);
    },
  },

  // --- venture intake (#387): brief ANY company idea into the already-built #96 venture loop ---
  // POSTs the typed intake to the live `POST /workspaces/:wid/ventures` (201 → the persisted idea). The
  // route is gated server-side behind the default-OFF owner-first `ventureIntake` flag (409 when off); the
  // web only surfaces this when its own VITE flag resolves on for the workspace. No money path is added.
  submitVenture(workspaceId: string, input: VentureIdeaInput): Promise<VentureIdeaDto> {
    return post(
      `/workspaces/${encodeURIComponent(workspaceId)}/ventures`,
      input,
    ) as Promise<VentureIdeaDto>;
  },

  // --- brand kit (#271): the owner's one-time brand identity the fleet draws from ---
  getBrandKit(): Promise<BrandKitState> {
    return request<BrandKitState>("/me/brand-kit");
  },
  setBrandKit(input: BrandKitInputDto): Promise<BrandKitState> {
    return request<BrandKitState>("/me/brand-kit", { method: "PUT", body: JSON.stringify(input) });
  },

  // --- marketing target (#502): what the fleet is marketing — the workspace's product or any external app ---
  getMarketingTarget(): Promise<MarketingTargetState> {
    return request<MarketingTargetState>("/me/marketing-target");
  },
  setMarketingTarget(input: MarketingTargetInputDto): Promise<MarketingTargetState> {
    return request<MarketingTargetState>("/me/marketing-target", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  // --- channels ---
  listChannels(workspaceId: string): Promise<Channel[]> {
    return request<Channel[]>(`/workspaces/${workspaceId}/channels`);
  },
  createChannel(workspaceId: string, name: string): Promise<Channel> {
    return post(`/workspaces/${workspaceId}/channels`, { name }) as Promise<Channel>;
  },

  // --- cloud scale (#71) ---
  getScaleUsage(workspaceId: string): Promise<UsageReport> {
    return request<UsageReport>(`/workspaces/${workspaceId}/scale/usage`);
  },

  // --- founder console (#104) ---
  getFounderConsole(workspaceId: string): Promise<FounderConsoleDto> {
    return request<FounderConsoleDto>(`/workspaces/${workspaceId}/founder-console`);
  },

  // --- inbound leads (#898): owner queue for captured hand-raises + 24h SLA state ---
  getInboundLeads(
    params: { status?: InboundLeadStatus; sinceMs?: number; limit?: number } = {},
  ): Promise<InboundLeadsResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.sinceMs !== undefined) qs.set("sinceMs", String(params.sinceMs));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.size ? `?${qs.toString()}` : "";
    return request<InboundLeadsResponse>(`/me/inbound/leads${suffix}`);
  },
  updateInboundLead(
    leadId: string,
    input: InboundLeadUpdateInput,
  ): Promise<{ lead: InboundLeadDto }> {
    return patch(`/me/inbound/leads/${encodeURIComponent(leadId)}`, input) as Promise<{
      lead: InboundLeadDto;
    }>;
  },

  // --- founder briefings (#173): the daily brief, weekly P&L report, and decision queue ---
  getFounderBriefingDaily(workspaceId: string): Promise<DailyBriefDto> {
    return request<DailyBriefDto>(`/workspaces/${workspaceId}/founder-briefings/daily`);
  },
  getFounderBriefingWeekly(workspaceId: string): Promise<WeeklyReportDto> {
    return request<WeeklyReportDto>(`/workspaces/${workspaceId}/founder-briefings/weekly`);
  },
  getFounderDecisionQueue(workspaceId: string): Promise<DecisionQueueDto> {
    return request<DecisionQueueDto>(`/workspaces/${workspaceId}/founder-briefings/decision-queue`);
  },

  // --- safety switches: the Founder Console wires these to the real, human-gated controls (#169 bug 12) ---
  /**
   * Engage / resume the autonomy kill switch (#17). Human-only + workspace-scoped server-side; the kill
   * switch HALTS autonomous sessions but does not touch the #13 approval gates. Throws ApiError on 403.
   */
  setKillSwitch(workspaceId: string, on: boolean): Promise<KillSwitchState> {
    return post(
      `/workspaces/${workspaceId}/autonomy/${on ? "kill" : "resume"}`,
    ) as Promise<KillSwitchState>;
  },
  /**
   * Flip maintenance mode (#99) — takes the platform read-only in seconds (allow-listed so it can always
   * be turned back off). Requires an authenticated identity; the flip is recorded with the member id.
   */
  setMaintenance(on: boolean, reason?: string): Promise<MaintenanceState> {
    return post("/maintenance", reason ? { on, reason } : { on }) as Promise<MaintenanceState>;
  },

  // --- public status page (#148) — UNauthenticated; needs no session cookie ---
  getStatusPage(slug: string): Promise<StatusPageDto> {
    return request<StatusPageDto>(`/status/${encodeURIComponent(slug)}`);
  },
  getPublicDogfoodFeed(slug: string): Promise<PublicDogfoodFeedDto> {
    return request<PublicDogfoodFeedDto>(`/dogfood/${encodeURIComponent(slug)}`);
  },
  getPublicSupportTicketStatus(
    workspaceId: string,
    ticketId: string,
    sourceRef: string,
  ): Promise<PublicSupportTicketStatusDto> {
    const qs = new URLSearchParams({ sourceRef });
    return request<PublicSupportTicketStatusDto>(
      `/support/widget/${encodeURIComponent(workspaceId)}/tickets/${encodeURIComponent(ticketId)}/status?${qs}`,
    );
  },

  // --- pricing + checkout (#125) ---
  billing: {
    /** The /pricing catalog + the workspace's active plan (un-gated — always renders). */
    listPlans(workspaceId: string): Promise<PlansResponseDto> {
      return request<PlansResponseDto>(`/workspaces/${workspaceId}/billing/plans`);
    },
    /**
     * #481 go-live status: the configured backend + declared mode + whether real money is on, so the
     * Settings → Billing panel renders the true state ("Live" vs "Test mode") instead of a fixed banner.
     */
    status(workspaceId: string): Promise<BillingStatusDto> {
      return request<BillingStatusDto>(`/workspaces/${workspaceId}/billing/status`);
    },
    listInvoices(workspaceId: string): Promise<BillingInvoicesResponseDto> {
      return request<BillingInvoicesResponseDto>(`/workspaces/${workspaceId}/billing/invoices`);
    },
    getInvoice(workspaceId: string, invoiceId: string): Promise<BillingInvoiceDto> {
      return request<BillingInvoiceDto>(
        `/workspaces/${workspaceId}/billing/invoices/${encodeURIComponent(invoiceId)}`,
      );
    },
    /**
     * Start checkout for a plan; returns the hosted URL to send the customer to. Throws ApiError on
     * 409/400/502. `returnUrl` (defaults to the app origin tagged `?checkout=success`) is where the hosted
     * link sends the payer back so the SPA can reflect the new plan on return.
     */
    startCheckout(
      workspaceId: string,
      planKey: string,
      billingInterval: "month" | "year" = "month",
      returnUrl: string = checkoutReturnUrl(),
      trackingRef?: string | null,
    ): Promise<CheckoutResponseDto> {
      return post(`/workspaces/${workspaceId}/billing/checkout`, {
        planKey,
        billingInterval,
        returnUrl,
        ...(trackingRef ? { trackingRef } : {}),
      }) as Promise<CheckoutResponseDto>;
    },
  },

  // --- messages & threads ---
  listMessages(channelId: string, limit?: number): Promise<Message[]> {
    const suffix =
      limit && Number.isFinite(limit) && limit > 0 ? `?limit=${Math.floor(limit)}` : "";
    return request<Message[]>(`/channels/${channelId}/messages${suffix}`);
  },
  postMessage(channelId: string, body: string, parentMessageId?: string): Promise<Message> {
    const payload = parentMessageId ? { body, parentMessageId } : { body };
    return post(`/channels/${channelId}/messages`, payload) as Promise<Message>;
  },
  getThread(channelId: string, messageId: string): Promise<ThreadView> {
    return request<ThreadView>(`/channels/${channelId}/messages/${messageId}/thread`);
  },
  postReply(
    channelId: string,
    messageId: string,
    body: string,
    alsoSendToChannel = false,
  ): Promise<Message> {
    return post(`/channels/${channelId}/messages/${messageId}/replies`, {
      body,
      alsoSendToChannel,
    }) as Promise<Message>;
  },
  launchTeamRun(channelId: string, subtasks: TeamRunSubtaskInput[]): Promise<TeamRunResponse> {
    return post(`/channels/${channelId}/team-runs`, { subtasks }) as Promise<TeamRunResponse>;
  },
  getCodexStatus(): Promise<CodexSubscriptionStatus> {
    return request<CodexSubscriptionStatus>("/me/codex/status");
  },

  // --- members & agents ---
  async searchMembers(workspaceId: string, q: string): Promise<MemberHit[]> {
    const env = await request<SearchEnvelope<MemberHit>>(
      `/workspaces/${workspaceId}/search/members?q=${encodeURIComponent(q)}&limit=100`,
    );
    return env.results;
  },
  listAgents(workspaceId: string): Promise<AgentProfile[]> {
    return request<AgentProfile[]>(`/workspaces/${workspaceId}/agents`);
  },

  // --- mentions ---
  listMyMentions(): Promise<MentionItem[]> {
    return request<MentionItem[]>("/me/mentions");
  },

  // --- approval gates (#13) ---
  approvals: {
    /** The review queue, optionally filtered by status. */
    async list(workspaceId: string, status?: string): Promise<ApprovalRequestDto[]> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      const payload = await request<ApprovalRequestDto[] | { items?: ApprovalRequestDto[] }>(
        `/workspaces/${workspaceId}/approvals${qs}`,
      );
      return Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
    },
    get(requestId: string): Promise<ApprovalRequestDto> {
      return request<ApprovalRequestDto>(`/approvals/${requestId}`);
    },
    /** The append-only audit chain for a request. */
    events(requestId: string): Promise<ApprovalEventDto[]> {
      return request<ApprovalEventDto[]>(`/approvals/${requestId}/events`);
    },
    /** Approve → execute (human-only). Throws ApiError on 403/409/502; callers reconcile. */
    approve(requestId: string, reason?: string): Promise<ApproveResult> {
      return post(
        `/approvals/${requestId}/approve`,
        reason ? { reason } : undefined,
      ) as Promise<ApproveResult>;
    },
    /** Reject with a reason (human-only). */
    reject(requestId: string, reason: string): Promise<RejectResult> {
      return post(`/approvals/${requestId}/reject`, { reason }) as Promise<RejectResult>;
    },
    listPolicies(workspaceId: string): Promise<ApprovalPolicyDto[]> {
      return request<ApprovalPolicyDto[]>(`/workspaces/${workspaceId}/approval-policies`);
    },
    upsertPolicy(workspaceId: string, input: UpsertPolicyInput): Promise<ApprovalPolicyDto> {
      return post(
        `/workspaces/${workspaceId}/approval-policies`,
        input,
      ) as Promise<ApprovalPolicyDto>;
    },
    deletePolicy(workspaceId: string, ruleId: string): Promise<{ ok: true }> {
      return del(`/workspaces/${workspaceId}/approval-policies/${ruleId}`) as Promise<{ ok: true }>;
    },
    simulatePolicy(workspaceId: string, input: PolicySimulationInput): Promise<PolicySimulationResult> {
      return post(
        `/workspaces/${workspaceId}/approval-policies/simulate`,
        input,
      ) as Promise<PolicySimulationResult>;
    },
    /** Submit an action through the gating seam — used by the demo to manufacture a gated request. */
    submitAction(workspaceId: string, input: SubmitActionInput): Promise<SubmitActionResponse> {
      return post(`/workspaces/${workspaceId}/actions`, input) as Promise<SubmitActionResponse>;
    },
  },

  // --- git / PR / diff / review (#51) ---
  review: {
    /** Agent sessions in a channel — the things that have a reviewable diff. */
    listSessions(channelId: string): Promise<AgentSessionSummary[]> {
      return request<AgentSessionSummary[]>(`/channels/${channelId}/agent-sessions`);
    },
    /** Launch an agent session with an optional model/provider/effort/Auto selection (#52). */
    launchSession(channelId: string, input: LaunchSessionInput): Promise<LaunchSessionResult> {
      return post(`/channels/${channelId}/agent-sessions`, input) as Promise<LaunchSessionResult>;
    },
    /**
     * Retry a FAILED run (#634): re-launch the same agent + model selection on a re-briefed task. The
     * original task is not persisted server-side, so the caller re-supplies it. Returns the new run.
     */
    retrySession(
      channelId: string,
      sessionId: string,
      input: { task: string },
    ): Promise<LaunchSessionResult> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/retry`,
        input,
      ) as Promise<LaunchSessionResult>;
    },
    /** A session's diff (cumulative or the latest turn). */
    diff(channelId: string, sessionId: string, mode: DiffMode): Promise<SessionDiff> {
      return request<SessionDiff>(
        `/channels/${channelId}/agent-sessions/${sessionId}/diff?mode=${mode}`,
      );
    },
    listComments(channelId: string, sessionId: string): Promise<ReviewCommentDto[]> {
      return request<ReviewCommentDto[]>(
        `/channels/${channelId}/agent-sessions/${sessionId}/review-comments`,
      );
    },
    addComment(
      channelId: string,
      sessionId: string,
      input: AddReviewCommentInput,
    ): Promise<{ comment: ReviewCommentDto }> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/review-comments`,
        input,
      ) as Promise<{ comment: ReviewCommentDto }>;
    },
    /** Deliver the session's undelivered comments to the agent as a new session (the round trip). */
    deliver(
      channelId: string,
      sessionId: string,
    ): Promise<{ sessionId: string | null; deliveredCount: number }> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/review-comments/deliver`,
      ) as Promise<{ sessionId: string | null; deliveredCount: number }>;
    },
    listPullRequests(channelId: string): Promise<PullRequestDto[]> {
      return request<PullRequestDto[]>(`/channels/${channelId}/pull-requests`);
    },
    createPullRequest(
      channelId: string,
      sessionId: string,
      input: CreatePrInput,
    ): Promise<{ pullRequest: PullRequestDto }> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/pull-request`,
        input,
      ) as Promise<{ pullRequest: PullRequestDto }>;
    },
    refreshChecks(
      channelId: string,
      prId: string,
    ): Promise<{ checksStatus: ChecksStatus; runs: CheckRunDto[] }> {
      return post(`/channels/${channelId}/pull-requests/${prId}/checks/refresh`) as Promise<{
        checksStatus: ChecksStatus;
        runs: CheckRunDto[];
      }>;
    },
    /** Forward failing CI to the agent as a new session. */
    fixCi(channelId: string, prId: string): Promise<{ sessionId: string }> {
      return post(`/channels/${channelId}/pull-requests/${prId}/fix-ci`) as Promise<{
        sessionId: string;
      }>;
    },
  },

  // --- run tab / preview + annotations (#56) ---
  run: {
    /** Start (or return the already-running) run process for a session's app. */
    start(channelId: string, sessionId: string): Promise<RunState> {
      return post(`/channels/${channelId}/agent-sessions/${sessionId}/run`) as Promise<RunState>;
    },
    /** Current run state (status + preview url + bounded log tail). */
    status(channelId: string, sessionId: string): Promise<RunState> {
      return request<RunState>(`/channels/${channelId}/agent-sessions/${sessionId}/run`);
    },
    /** Stop the run process. */
    stop(channelId: string, sessionId: string): Promise<{ ok: boolean; stopped: boolean }> {
      return post(`/channels/${channelId}/agent-sessions/${sessionId}/run/stop`) as Promise<{
        ok: boolean;
        stopped: boolean;
      }>;
    },
    /** Deliver preview annotations to the agent as a follow-up session (the round trip). */
    sendAnnotations(
      channelId: string,
      sessionId: string,
      annotations: PreviewAnnotation[],
    ): Promise<{ sessionId: string; count: number }> {
      return post(`/channels/${channelId}/agent-sessions/${sessionId}/annotations`, {
        annotations,
      }) as Promise<{ sessionId: string; count: number }>;
    },
  },

  // --- deploy to a live url (#73) ---
  deploy: {
    /** Deploy (or redeploy — a new immutable deployment) the session's app to a live HTTPS URL. */
    start(channelId: string, sessionId: string, reason?: string): Promise<DeploymentDto> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/deploy`,
        reason ? { reason } : undefined,
      ) as Promise<DeploymentDto>;
    },
    /** Latest deployment state (status + url + redacted log tail); null when none yet. */
    async status(channelId: string, sessionId: string): Promise<DeploymentDto | null> {
      try {
        return await request<DeploymentDto>(
          `/channels/${channelId}/agent-sessions/${sessionId}/deploy`,
        );
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    /** Deployment history for the session, newest first (the backup set). */
    history(channelId: string, sessionId: string): Promise<DeploymentDto[]> {
      return request<DeploymentDto[]>(
        `/channels/${channelId}/agent-sessions/${sessionId}/deploy/history`,
      );
    },
    /** Roll back to the prior good deployment. */
    rollback(channelId: string, sessionId: string): Promise<DeploymentDto> {
      return post(
        `/channels/${channelId}/agent-sessions/${sessionId}/deploy/rollback`,
      ) as Promise<DeploymentDto>;
    },
    /** One-click scaling (bounded server-side to the configured maxInstances). */
    scale(channelId: string, sessionId: string, instances: number): Promise<{ ok: boolean }> {
      return post(`/channels/${channelId}/agent-sessions/${sessionId}/deploy/scale`, {
        instances,
      }) as Promise<{ ok: boolean }>;
    },
  },

  // --- Ona-class agent infrastructure (#147) ---
  /** The task-template gallery; pass a channel id to scope it to that channel's department. */
  getTaskTemplates(workspaceId: string, channelId?: string): Promise<TaskTemplateDto[]> {
    const qs = channelId ? `?channel=${encodeURIComponent(channelId)}` : "";
    return request<TaskTemplateDto[]>(`/workspaces/${workspaceId}/task-templates${qs}`);
  },
  automations: {
    list(workspaceId: string): Promise<AutomationDto[]> {
      return request<AutomationDto[]>(`/workspaces/${workspaceId}/automations`);
    },
    create(
      workspaceId: string,
      input: Record<string, unknown> & { name: string },
    ): Promise<AutomationDto> {
      return post(`/workspaces/${workspaceId}/automations`, input) as Promise<AutomationDto>;
    },
    setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<AutomationDto> {
      return post(`/workspaces/${workspaceId}/automations/${id}/enable`, {
        enabled,
      }) as Promise<AutomationDto>;
    },
    run(workspaceId: string, id: string): Promise<AutomationRunDto> {
      return post(`/workspaces/${workspaceId}/automations/${id}/run`) as Promise<AutomationRunDto>;
    },
    remove(workspaceId: string, id: string): Promise<unknown> {
      return del(`/workspaces/${workspaceId}/automations/${id}`);
    },
  },
  /** Workspace catalog (#152): the marketing-asset registry (default-OFF server-side → 403 when dark). */
  catalog: {
    list(workspaceId: string, kind?: string): Promise<CatalogEntryDto[]> {
      const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
      return request<CatalogEntryDto[]>(`/workspaces/${workspaceId}/catalog${qs}`);
    },
    create(
      workspaceId: string,
      input: Record<string, unknown> & { kind: string; name: string },
    ): Promise<CatalogEntryDto> {
      return post(`/workspaces/${workspaceId}/catalog`, input) as Promise<CatalogEntryDto>;
    },
    update(
      workspaceId: string,
      id: string,
      patchBody: Record<string, unknown>,
    ): Promise<CatalogEntryDto> {
      return patch(
        `/workspaces/${workspaceId}/catalog/${id}`,
        patchBody,
      ) as Promise<CatalogEntryDto>;
    },
    remove(workspaceId: string, id: string): Promise<unknown> {
      return del(`/workspaces/${workspaceId}/catalog/${id}`);
    },
  },
  /** Visual workflow builder (#152): trigger → condition → action chains (firing is default-OFF server-side). */
  workflows: {
    list(workspaceId: string): Promise<WorkflowDto[]> {
      return request<WorkflowDto[]>(`/workspaces/${workspaceId}/workflows`);
    },
    create(
      workspaceId: string,
      input: Record<string, unknown> & { name: string },
    ): Promise<WorkflowDto> {
      return post(`/workspaces/${workspaceId}/workflows`, input) as Promise<WorkflowDto>;
    },
    setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<WorkflowDto> {
      return post(`/workspaces/${workspaceId}/workflows/${id}/enable`, {
        enabled,
      }) as Promise<WorkflowDto>;
    },
    run(workspaceId: string, id: string): Promise<WorkflowRunDto> {
      return post(`/workspaces/${workspaceId}/workflows/${id}/run`) as Promise<WorkflowRunDto>;
    },
    runs(workspaceId: string, id: string): Promise<WorkflowRunDto[]> {
      return request<WorkflowRunDto[]>(`/workspaces/${workspaceId}/workflows/${id}/runs`);
    },
    insights(workspaceId: string): Promise<WorkflowInsightsDto> {
      return request<WorkflowInsightsDto>(`/workspaces/${workspaceId}/workflows-insights`);
    },
    remove(workspaceId: string, id: string): Promise<unknown> {
      return del(`/workspaces/${workspaceId}/workflows/${id}`);
    },
  },
  /** The append-only audit trail (who/what/when/gated-by), newest first. */
  getAudit(workspaceId: string): Promise<AuditEventDto[]> {
    return request<AuditEventDto[]>(`/workspaces/${workspaceId}/audit`);
  },
  // --- founding-team department fleet (#123/#138) — the first-run activation seam ---
  department: {
    /**
     * Stand up the founding team for a workspace: seven department channels, each with a named lead
     * (idempotent, human-auth). With `welcomeTasks`, each lead launches its first real welcome session —
     * so a dead first-run board lights up with running work. The same seam #187's bootstrap reuses.
     */
    seed(
      workspaceId: string,
      opts: { welcomeTasks?: boolean } = {},
    ): Promise<DepartmentSeedResult> {
      return post(`/workspaces/${workspaceId}/department/seed`, {
        welcomeTasks: opts.welcomeTasks ?? false,
      }) as Promise<DepartmentSeedResult>;
    },
    /**
     * Brief a department lead (#235): hand them a goal and launch a REAL session down the audited @mention
     * path. Returns the launched sessions (or a connect-prompt when no Claude is connected). Throws ApiError
     * on a 4xx/5xx (e.g. 409 fleet-not-seeded, 402/429 budget/kill-switch) — callers reconcile.
     */
    brief(
      workspaceId: string,
      input: { lead: string; goal: string },
    ): Promise<DepartmentBriefResult> {
      return post(
        `/workspaces/${workspaceId}/department/brief`,
        input,
      ) as Promise<DepartmentBriefResult>;
    },
    /**
     * #371 named-department roster: the reload.chat "team" view — the members-rail footer
     * ("{n} humans · {n} agents · {n} decisions captured") + the per-teammate enable flags. Read-only.
     */
    view(): Promise<DepartmentViewDto> {
      return request<DepartmentViewDto>("/me/department");
    },
  },
  missionControl: {
    get(workspaceId: string): Promise<MissionControlDto> {
      return request<MissionControlDto>(`/workspaces/${workspaceId}/mission-control`);
    },
    stop(workspaceId: string, sessionId: string): Promise<{ canceled: boolean }> {
      return post(
        `/workspaces/${workspaceId}/mission-control/sessions/${sessionId}/stop`,
      ) as Promise<{
        canceled: boolean;
      }>;
    },
    steer(
      workspaceId: string,
      sessionId: string,
      guidance: string,
    ): Promise<{ delivered: boolean }> {
      return post(`/workspaces/${workspaceId}/mission-control/sessions/${sessionId}/steer`, {
        guidance,
      }) as Promise<{ delivered: boolean }>;
    },
  },
  traces: {
    /** Complete per-run trace (#664): every persisted step, tool call/result, payload, timing, and error. */
    get(workspaceId: string, runId: string): Promise<AgentTraceDto> {
      return request<AgentTraceDto>(
        `/workspaces/${encodeURIComponent(workspaceId)}/traces/${encodeURIComponent(runId)}`,
      );
    },
  },

  // --- public marketing site (CMS-lite, #153) ---
  site: {
    /** List the published documents in a section (metadata only). */
    section(section: string): Promise<SiteDocMeta[]> {
      return request<{ docs: SiteDocMeta[] }>(`/site/content/${section}`).then((r) => r.docs);
    },
    /** One published document with its body rendered to typed blocks, or null when missing/draft. */
    async doc(section: string, slug: string): Promise<SiteDocDetail | null> {
      try {
        return (await request<{ doc: SiteDocDetail }>(`/site/content/${section}/${slug}`)).doc;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    /** The changelog entries, newest-first. */
    changelog(): Promise<SiteDocMeta[]> {
      return request<{ entries: SiteDocMeta[] }>("/site/changelog").then((r) => r.entries);
    },
  },

  // --- global spend cap + governor (#670) ---
  budget: {
    /** The workspace's live spend position + pending cap-raises. Throws ApiError(409) when disabled. */
    status(workspaceId: string): Promise<BudgetResponse> {
      return request<BudgetResponse>(`/workspaces/${workspaceId}/budget`);
    },
    /** Request a cap RAISE (parked pending — takes effect only once a human approves). */
    requestRaise(workspaceId: string, toCents: number): Promise<{ raise: CapRaiseDto }> {
      return post(`/workspaces/${workspaceId}/budget/cap/raise`, { toCents }) as Promise<{
        raise: CapRaiseDto;
      }>;
    },
    /** Lower the cap immediately (tightening never needs approval). */
    lower(workspaceId: string, toCents: number): Promise<{ status: BudgetStatusDto }> {
      return post(`/workspaces/${workspaceId}/budget/cap/lower`, { toCents }) as Promise<{
        status: BudgetStatusDto;
      }>;
    },
    /** Approve a pending cap-raise (the recorded human approval). */
    approveRaise(
      workspaceId: string,
      raiseId: string,
      reason?: string,
    ): Promise<RaiseDecisionResult> {
      return post(
        `/workspaces/${workspaceId}/budget/raises/${raiseId}/approve`,
        reason ? { reason } : undefined,
      ) as Promise<RaiseDecisionResult>;
    },
    /** Reject a pending cap-raise (the cap is unchanged). */
    rejectRaise(
      workspaceId: string,
      raiseId: string,
      reason?: string,
    ): Promise<RaiseDecisionResult> {
      return post(
        `/workspaces/${workspaceId}/budget/raises/${raiseId}/reject`,
        reason ? { reason } : undefined,
      ) as Promise<RaiseDecisionResult>;
    },
  },
};

/** The result of approving/rejecting a cap-raise (#670). */
export interface RaiseDecisionResult {
  raise: CapRaiseDto;
  status: BudgetStatusDto;
}
