/**
 * The single in-memory app store. Holds all UI state, orchestrates REST + realtime, and exposes a
 * `useSyncExternalStore`-compatible `subscribe`/`getState` pair. No router, no Redux — one store.
 *
 * State is immutable: every mutation replaces `state` with a new object so `getState()` returns a
 * stable reference between notifications (what `useSyncExternalStore` requires).
 */
import type {
  ApprovalEventDto,
  ApprovalPolicyDto,
  ApprovalRequestDto,
  ApprovalStatus,
  DiffMode,
  PullRequestDto,
  ReviewCommentDto,
  SessionDiff,
} from "@reload/shared";
import type { api as realApi, AddReviewCommentInput, CreatePrInput } from "../api/client.js";
import type { Realtime } from "../api/realtime.js";
import type {
  AgentProfile,
  AgentSessionSummary,
  Channel,
  Identity,
  MemberHit,
  MentionEvent,
  Message,
  PresenceStatus,
} from "../api/types.js";

export interface DirectoryEntry {
  id: string;
  kind: "human" | "agent";
  displayName: string;
}

export interface ThreadState {
  channelId: string;
  root: Message;
  replies: Message[];
}

/** The approvals slice (#13 web surface). The review queue, the open request + its audit chain,
 * and the workspace policy rules. `pendingCount` drives a live nav badge independent of the view. */
export interface ApprovalsState {
  status: ApprovalStatus;
  requests: ApprovalRequestDto[];
  loading: boolean;
  pendingCount: number;
  activeRequest: ApprovalRequestDto | null;
  activeEvents: ApprovalEventDto[];
  policies: ApprovalPolicyDto[];
  error: string | null;
}

/** The review slice (#51 git/PR/diff web surface). The active channel's agent sessions and PRs,
 * the selected session's diff + comments, and the diff mode toggle. */
export interface ReviewState {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  diff: SessionDiff | null;
  diffMode: DiffMode;
  comments: ReviewCommentDto[];
  pullRequests: PullRequestDto[];
  loading: boolean;
  error: string | null;
}

export interface AppState {
  phase: "loading" | "anon" | "ready";
  identity: Identity | null;
  channels: Channel[];
  activeChannelId: string | null;
  messagesByChannel: Record<string, Message[]>;
  thread: ThreadState | null;
  directory: Record<string, DirectoryEntry>;
  agents: AgentProfile[];
  presence: Record<string, PresenceStatus>;
  mentions: MentionEvent[];
  unreadMentions: number;
  approvals: ApprovalsState;
  review: ReviewState;
  error: string | null;
}

/** The slice of the REST client the store depends on (so tests can supply a fake). */
export interface StoreDeps {
  api: Pick<
    typeof realApi,
    | "me"
    | "login"
    | "signup"
    | "logout"
    | "listChannels"
    | "createChannel"
    | "listMessages"
    | "postMessage"
    | "getThread"
    | "postReply"
    | "searchMembers"
    | "listAgents"
    | "listMyMentions"
    | "approvals"
    | "review"
  >;
  realtime: Realtime;
}

// --- pure helpers (unit-tested directly) ----------------------------------------------------

/** Append `msg` if its id is new, else replace the existing entry in place. */
export function upsertMessage(list: Message[], msg: Message): Message[] {
  const idx = list.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...list, msg];
  const next = list.slice();
  next[idx] = msg;
  return next;
}

/** A human-readable author label: the directory display name, or a short member-id fallback. */
export function authorLabel(dir: Record<string, DirectoryEntry>, memberId: string): string {
  return dir[memberId]?.displayName ?? `member-${memberId.slice(0, 6)}`;
}

function mergeDirectory(
  dir: Record<string, DirectoryEntry>,
  entries: DirectoryEntry[],
): Record<string, DirectoryEntry> {
  const next = { ...dir };
  for (const e of entries) next[e.id] = e;
  return next;
}

// Vowels approximate "every display name" for the member ILIKE search, since the server exposes
// no list-all-members endpoint (see spec §Known server constraints).
const ROSTER_PROBES = ["a", "e", "i", "o", "u", "y"];

const INITIAL_APPROVALS: ApprovalsState = {
  status: "pending",
  requests: [],
  loading: false,
  pendingCount: 0,
  activeRequest: null,
  activeEvents: [],
  policies: [],
  error: null,
};

const INITIAL_REVIEW: ReviewState = {
  sessions: [],
  activeSessionId: null,
  diff: null,
  diffMode: "cumulative",
  comments: [],
  pullRequests: [],
  loading: false,
  error: null,
};

const INITIAL: AppState = {
  phase: "loading",
  identity: null,
  channels: [],
  activeChannelId: null,
  messagesByChannel: {},
  thread: null,
  directory: {},
  agents: [],
  presence: {},
  mentions: [],
  unreadMentions: 0,
  approvals: INITIAL_APPROVALS,
  review: INITIAL_REVIEW,
  error: null,
};

export interface Store {
  getState(): AppState;
  subscribe(listener: () => void): () => void;
  bootstrap(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  signup(input: {
    email: string;
    password: string;
    displayName: string;
    workspaceSlug: string;
  }): Promise<void>;
  logout(): Promise<void>;
  selectChannel(channelId: string): Promise<void>;
  createChannel(name: string): Promise<void>;
  sendMessage(body: string): Promise<void>;
  openThread(messageId: string): Promise<void>;
  closeThread(): void;
  sendReply(rootId: string, body: string, alsoSendToChannel: boolean): Promise<void>;
  searchMembers(query: string): Promise<MemberHit[]>;
  markMentionsRead(): void;
  // --- approvals (#13 web surface) ---
  loadApprovals(status?: ApprovalStatus): Promise<void>;
  openRequest(requestId: string): Promise<void>;
  closeRequest(): void;
  decideApprove(requestId: string, reason?: string): Promise<void>;
  decideReject(requestId: string, reason: string): Promise<void>;
  loadPolicies(): Promise<void>;
  addPolicy(input: { actionType: string; requireApproval?: boolean; maxAutoAmount?: number | null }): Promise<void>;
  removePolicy(ruleId: string): Promise<void>;
  // --- git / PR / diff / review (#51 web surface) ---
  loadReview(): Promise<void>;
  selectReviewSession(sessionId: string): Promise<void>;
  setDiffMode(mode: DiffMode): Promise<void>;
  addReviewComment(input: AddReviewCommentInput): Promise<void>;
  deliverComments(): Promise<number>;
  createPullRequest(input: CreatePrInput): Promise<void>;
  refreshChecks(prId: string): Promise<void>;
  fixCi(prId: string): Promise<void>;
}

/** Server `error` message off an ApiError, or a generic fallback. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "request failed";
}

export function createStore({ api, realtime }: StoreDeps): Store {
  let state: AppState = INITIAL;
  const listeners = new Set<() => void>();

  function set(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  }

  function onEvent(event: import("../api/types.js").ServerEvent): void {
    switch (event.type) {
      case "message": {
        const m = event.message;
        const list = state.messagesByChannel[m.channelId] ?? [];
        const messagesByChannel = { ...state.messagesByChannel, [m.channelId]: upsertMessage(list, m) };
        let thread = state.thread;
        if (thread && m.parentMessageId === thread.root.id && thread.channelId === m.channelId) {
          thread = { ...thread, replies: upsertMessage(thread.replies, m) };
        }
        set({ messagesByChannel, thread });
        break;
      }
      case "mention":
        set({ mentions: [event.mention, ...state.mentions], unreadMentions: state.unreadMentions + 1 });
        break;
      case "notification":
        // A gated action (#13) needs a human decision — refresh the pending queue live (ADR-0026).
        if (event.notification.type === "approval") void refreshPending();
        break;
      case "presence":
        set({ presence: { ...state.presence, [event.memberId]: event.status } });
        break;
      case "pull_request": {
        // Upsert the PR into the review slice so the panel reflects create/checks changes live.
        const pr = event.pullRequest;
        const existing = state.review.pullRequests;
        const idx = existing.findIndex((p) => p.id === pr.id);
        const pullRequests = idx === -1 ? [pr, ...existing] : existing.map((p) => (p.id === pr.id ? pr : p));
        setReview({ pullRequests });
        break;
      }
      case "review_comment": {
        // Append a new comment when it belongs to the session currently being reviewed.
        const c = event.comment;
        if (c.sessionId === state.review.activeSessionId && !state.review.comments.some((x) => x.id === c.id)) {
          setReview({ comments: [...state.review.comments, c] });
        }
        break;
      }
      default:
        // ready / subscribed / unsubscribed / error / pong — no UI state to update.
        break;
    }
  }

  function setApprovals(patch: Partial<ApprovalsState>): void {
    set({ approvals: { ...state.approvals, ...patch } });
  }

  function setReview(patch: Partial<ReviewState>): void {
    set({ review: { ...state.review, ...patch } });
  }

  /** Refresh the pending bucket: always updates the nav badge; updates rows when pending is shown.
   * Best-effort — a failure only zeroes the badge, never breaks login or a decision. */
  async function refreshPending(): Promise<void> {
    const workspaceId = state.identity?.workspaceId;
    if (!workspaceId) return;
    try {
      const pending = await api.approvals.list(workspaceId, "pending");
      const patch: Partial<ApprovalsState> = { pendingCount: pending.length };
      if (state.approvals.status === "pending") patch.requests = pending;
      setApprovals(patch);
    } catch {
      // best-effort: the badge/queue degrade, the rest of the app is unaffected.
    }
  }

  /** After any decision, reload the visible queue + the badge, and refresh an open detail. */
  async function reconcile(requestId: string): Promise<void> {
    await store.loadApprovals(state.approvals.status);
    if (state.approvals.status !== "pending") await refreshPending();
    if (state.approvals.activeRequest?.id === requestId) await store.openRequest(requestId);
  }

  async function warmDirectory(workspaceId: string): Promise<void> {
    try {
      const batches = await Promise.all(ROSTER_PROBES.map((q) => api.searchMembers(workspaceId, q)));
      const hits = batches.flat();
      if (hits.length) set({ directory: mergeDirectory(state.directory, hits) });
    } catch {
      // Best-effort: a roster miss only degrades author labels to id fallbacks.
    }
  }

  async function loadWorkspace(identity: Identity): Promise<void> {
    realtime.on(onEvent);
    realtime.connect();

    const [channels, agents] = await Promise.all([
      api.listChannels(identity.workspaceId),
      api.listAgents(identity.workspaceId).catch(() => [] as AgentProfile[]),
    ]);

    const selfEntry: DirectoryEntry = {
      id: identity.memberId,
      kind: identity.kind,
      displayName: identity.displayName,
    };
    set({
      phase: "ready",
      identity,
      channels,
      agents,
      directory: mergeDirectory(state.directory, [selfEntry]),
      presence: { ...state.presence, [identity.memberId]: "online" },
    });

    void warmDirectory(identity.workspaceId);
    api
      .listMyMentions()
      .then((items) => set({ unreadMentions: items.length }))
      .catch(() => undefined);
    await refreshPending();

    const first = channels[0];
    if (first) await store.selectChannel(first.id);
  }

  const store: Store = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async bootstrap() {
      try {
        const identity = await api.me();
        await loadWorkspace(identity);
      } catch {
        set({ phase: "anon", identity: null });
      }
    },

    async login(email, password) {
      await api.login(email, password);
      set({ error: null });
      await store.bootstrap();
    },

    async signup(input) {
      await api.signup(input);
      set({ error: null });
      await store.bootstrap();
    },

    async logout() {
      realtime.close();
      await api.logout().catch(() => undefined);
      state = { ...INITIAL, phase: "anon" };
      for (const l of listeners) l();
    },

    async selectChannel(channelId) {
      set({ activeChannelId: channelId, thread: null });
      realtime.subscribe(channelId);
      const messages = await api.listMessages(channelId);
      set({ messagesByChannel: { ...state.messagesByChannel, [channelId]: messages } });
    },

    async createChannel(name) {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return;
      const channel = await api.createChannel(workspaceId, name);
      set({ channels: [...state.channels, channel] });
      await store.selectChannel(channel.id);
    },

    async sendMessage(body) {
      const channelId = state.activeChannelId;
      if (!channelId || !body.trim()) return;
      const msg = await api.postMessage(channelId, body);
      const list = state.messagesByChannel[channelId] ?? [];
      set({ messagesByChannel: { ...state.messagesByChannel, [channelId]: upsertMessage(list, msg) } });
    },

    async openThread(messageId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      const view = await api.getThread(channelId, messageId);
      set({ thread: { channelId, root: view.root, replies: view.replies } });
    },

    closeThread() {
      set({ thread: null });
    },

    async sendReply(rootId, body, alsoSendToChannel) {
      const channelId = state.activeChannelId;
      if (!channelId || !body.trim()) return;
      const reply = await api.postReply(channelId, rootId, body, alsoSendToChannel);
      const thread = state.thread;
      if (thread && thread.root.id === rootId) {
        set({ thread: { ...thread, replies: upsertMessage(thread.replies, reply) } });
      }
      if (alsoSendToChannel) {
        const list = state.messagesByChannel[channelId] ?? [];
        set({
          messagesByChannel: { ...state.messagesByChannel, [channelId]: upsertMessage(list, reply) },
        });
      }
    },

    async searchMembers(query) {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return [];
      const hits = await api.searchMembers(workspaceId, query);
      if (hits.length) set({ directory: mergeDirectory(state.directory, hits) });
      return hits;
    },

    markMentionsRead() {
      if (state.unreadMentions !== 0) set({ unreadMentions: 0 });
    },

    // --- approvals (#13 web surface) ---

    async loadApprovals(status = state.approvals.status) {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return;
      setApprovals({ status, loading: true, error: null });
      try {
        const requests = await api.approvals.list(workspaceId, status);
        const patch: Partial<ApprovalsState> = { requests, loading: false };
        if (status === "pending") patch.pendingCount = requests.length;
        setApprovals(patch);
      } catch (e) {
        setApprovals({ loading: false, error: errMsg(e) });
      }
    },

    async openRequest(requestId) {
      try {
        const [request, events] = await Promise.all([
          api.approvals.get(requestId),
          api.approvals.events(requestId),
        ]);
        setApprovals({ activeRequest: request, activeEvents: events, error: null });
      } catch (e) {
        setApprovals({ error: errMsg(e) });
      }
    },

    closeRequest() {
      setApprovals({ activeRequest: null, activeEvents: [] });
    },

    async decideApprove(requestId, reason) {
      let error: string | null = null;
      try {
        await api.approvals.approve(requestId, reason);
      } catch (e) {
        error = errMsg(e);
      }
      // Reconcile against authoritative server state (handles 409 already-decided / 502 failed).
      await reconcile(requestId);
      if (error) setApprovals({ error });
    },

    async decideReject(requestId, reason) {
      let error: string | null = null;
      try {
        await api.approvals.reject(requestId, reason);
      } catch (e) {
        error = errMsg(e);
      }
      await reconcile(requestId);
      if (error) setApprovals({ error });
    },

    async loadPolicies() {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return;
      try {
        const policies = await api.approvals.listPolicies(workspaceId);
        setApprovals({ policies, error: null });
      } catch (e) {
        setApprovals({ error: errMsg(e) });
      }
    },

    async addPolicy(input) {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return;
      let error: string | null = null;
      try {
        await api.approvals.upsertPolicy(workspaceId, input);
      } catch (e) {
        error = errMsg(e);
      }
      await store.loadPolicies();
      if (error) setApprovals({ error });
    },

    async removePolicy(ruleId) {
      const workspaceId = state.identity?.workspaceId;
      if (!workspaceId) return;
      let error: string | null = null;
      try {
        await api.approvals.deletePolicy(workspaceId, ruleId);
      } catch (e) {
        error = errMsg(e);
      }
      await store.loadPolicies();
      if (error) setApprovals({ error });
    },

    // --- git / PR / diff / review (#51 web surface) ---

    /** Load the active channel's agent sessions + PRs, then select the first session (if any). */
    async loadReview() {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setReview({ loading: true, error: null });
      try {
        const [sessions, pullRequests] = await Promise.all([
          api.review.listSessions(channelId),
          api.review.listPullRequests(channelId).catch(() => [] as PullRequestDto[]),
        ]);
        setReview({ sessions, pullRequests, loading: false });
        const first = sessions[0];
        if (first && first.id !== state.review.activeSessionId) await store.selectReviewSession(first.id);
      } catch (e) {
        setReview({ loading: false, error: errMsg(e) });
      }
    },

    /** Select a session and load its diff + comments. */
    async selectReviewSession(sessionId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setReview({ activeSessionId: sessionId, diff: null, comments: [], error: null });
      try {
        const [diff, comments] = await Promise.all([
          api.review.diff(channelId, sessionId, state.review.diffMode),
          api.review.listComments(channelId, sessionId).catch(() => [] as ReviewCommentDto[]),
        ]);
        setReview({ diff, comments });
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },

    /** Switch the diff mode (cumulative ⇄ turn) and reload the active session's diff. */
    async setDiffMode(mode) {
      setReview({ diffMode: mode });
      const channelId = state.activeChannelId;
      const sessionId = state.review.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        const diff = await api.review.diff(channelId, sessionId, mode);
        setReview({ diff });
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },

    async addReviewComment(input) {
      const channelId = state.activeChannelId;
      const sessionId = state.review.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        const { comment } = await api.review.addComment(channelId, sessionId, input);
        if (!state.review.comments.some((c) => c.id === comment.id)) {
          setReview({ comments: [...state.review.comments, comment] });
        }
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },

    /** Deliver the session's undelivered comments to the agent. Returns how many were delivered. */
    async deliverComments() {
      const channelId = state.activeChannelId;
      const sessionId = state.review.activeSessionId;
      if (!channelId || !sessionId) return 0;
      try {
        const res = await api.review.deliver(channelId, sessionId);
        // Refresh comments so the delivered marker shows.
        const comments = await api.review.listComments(channelId, sessionId);
        setReview({ comments });
        return res.deliveredCount;
      } catch (e) {
        setReview({ error: errMsg(e) });
        return 0;
      }
    },

    async createPullRequest(input) {
      const channelId = state.activeChannelId;
      const sessionId = state.review.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        const { pullRequest } = await api.review.createPullRequest(channelId, sessionId, input);
        const existing = state.review.pullRequests;
        const pullRequests = existing.some((p) => p.id === pullRequest.id)
          ? existing.map((p) => (p.id === pullRequest.id ? pullRequest : p))
          : [pullRequest, ...existing];
        setReview({ pullRequests });
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },

    async refreshChecks(prId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      try {
        const { checksStatus } = await api.review.refreshChecks(channelId, prId);
        setReview({
          pullRequests: state.review.pullRequests.map((p) =>
            p.id === prId ? { ...p, checksStatus } : p,
          ),
        });
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },

    async fixCi(prId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      try {
        await api.review.fixCi(channelId, prId);
      } catch (e) {
        setReview({ error: errMsg(e) });
      }
    },
  };

  return store;
}
