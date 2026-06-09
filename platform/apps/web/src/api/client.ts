/**
 * Typed REST client for the Reload server. Every call is same-origin (the Vite dev proxy and the
 * production deployment both serve the app from the API origin), so the httpOnly `rid` session
 * cookie rides along automatically — we just set `credentials: "include"` to be explicit.
 */
import type {
  ApprovalEventDto,
  ApprovalPolicyDto,
  ApprovalRequestDto,
  CheckRunDto,
  ChecksStatus,
  DiffMode,
  PreviewAnnotation,
  PullRequestDto,
  ReviewCommentDto,
  RunState,
  SessionDiff,
  SubmitActionResponse,
} from "@reload/shared";
import type {
  AgentProfile,
  AgentSessionSummary,
  Channel,
  Identity,
  MemberHit,
  MentionItem,
  Message,
  SearchEnvelope,
  ThreadView,
} from "./types.js";

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

/** Error thrown for any non-2xx response, carrying the server's `error` string and HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  let payload: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return payload as T;
}

function post(path: string, body?: unknown): Promise<unknown> {
  return request(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

function del(path: string): Promise<unknown> {
  return request(path, { method: "DELETE" });
}

export const api = {
  // --- auth ---
  signup(input: {
    email: string;
    password: string;
    displayName: string;
    workspaceSlug: string;
  }): Promise<{ ok: true }> {
    return post("/auth/signup", input) as Promise<{ ok: true }>;
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

  // --- channels ---
  listChannels(workspaceId: string): Promise<Channel[]> {
    return request<Channel[]>(`/workspaces/${workspaceId}/channels`);
  },
  createChannel(workspaceId: string, name: string): Promise<Channel> {
    return post(`/workspaces/${workspaceId}/channels`, { name }) as Promise<Channel>;
  },

  // --- messages & threads ---
  listMessages(channelId: string): Promise<Message[]> {
    return request<Message[]>(`/channels/${channelId}/messages`);
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
    list(workspaceId: string, status?: string): Promise<ApprovalRequestDto[]> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<ApprovalRequestDto[]>(`/workspaces/${workspaceId}/approvals${qs}`);
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
      return post(`/approvals/${requestId}/approve`, reason ? { reason } : undefined) as Promise<ApproveResult>;
    },
    /** Reject with a reason (human-only). */
    reject(requestId: string, reason: string): Promise<RejectResult> {
      return post(`/approvals/${requestId}/reject`, { reason }) as Promise<RejectResult>;
    },
    listPolicies(workspaceId: string): Promise<ApprovalPolicyDto[]> {
      return request<ApprovalPolicyDto[]>(`/workspaces/${workspaceId}/approval-policies`);
    },
    upsertPolicy(workspaceId: string, input: UpsertPolicyInput): Promise<ApprovalPolicyDto> {
      return post(`/workspaces/${workspaceId}/approval-policies`, input) as Promise<ApprovalPolicyDto>;
    },
    deletePolicy(workspaceId: string, ruleId: string): Promise<{ ok: true }> {
      return del(`/workspaces/${workspaceId}/approval-policies/${ruleId}`) as Promise<{ ok: true }>;
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
};
