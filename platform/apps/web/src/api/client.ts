/**
 * Typed REST client for the Reload server. Every call is same-origin (the Vite dev proxy and the
 * production deployment both serve the app from the API origin), so the httpOnly `rid` session
 * cookie rides along automatically — we just set `credentials: "include"` to be explicit.
 */
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
};
