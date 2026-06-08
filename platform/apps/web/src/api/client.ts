/**
 * Typed REST client for the Reload server. Every call is same-origin (the Vite dev proxy and the
 * production deployment both serve the app from the API origin), so the httpOnly `rid` session
 * cookie rides along automatically — we just set `credentials: "include"` to be explicit.
 */
import type {
  ApprovalEventDto,
  ApprovalPolicyDto,
  ApprovalRequestDto,
  SubmitActionResponse,
} from "@reload/shared";
import type {
  AgentProfile,
  Channel,
  Identity,
  MemberHit,
  MentionItem,
  Message,
  SearchEnvelope,
  ThreadView,
} from "./types.js";

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
};
