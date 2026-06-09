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
} from "@reload/shared";
import type { api as realApi } from "../api/client.js";
import type { Realtime } from "../api/realtime.js";
import {
  beginEdit,
  cancelEdit,
  commitEdit,
  editText,
  emptyQueue,
  enqueue,
  enqueueSteer,
  moveItem,
  removeItem,
  takeHead,
  type QueueItem,
  type SessionQueue,
} from "./queue.js";
import type {
  AgentProfile,
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
  /** Per-session (per-channel) composer message/steering queue (#54). Keyed by channelId so each
   * conversation keeps its own stack across channel switches. */
  queues: Record<string, SessionQueue>;
  error: string | null;
}

/** Re-export so consumers (components) get the queue types from the store barrel. */
export type { QueueItem, SessionQueue } from "./queue.js";

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
  queues: {},
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
  // --- composer message/steering queue (#54), scoped to the active channel ---
  /** Stack a message after everything already pending; drains when the agent is ready. */
  queueMessage(text: string): void;
  /** Stack a message ahead of the queued backlog (redirect now). */
  steerMessage(text: string): void;
  editQueuedStart(itemId: string): void;
  editQueuedChange(text: string): void;
  editQueuedCommit(): void;
  editQueuedCancel(): void;
  removeQueued(itemId: string): void;
  moveQueued(itemId: string, dir: -1 | 1): void;
  // --- approvals (#13 web surface) ---
  loadApprovals(status?: ApprovalStatus): Promise<void>;
  openRequest(requestId: string): Promise<void>;
  closeRequest(): void;
  decideApprove(requestId: string, reason?: string): Promise<void>;
  decideReject(requestId: string, reason: string): Promise<void>;
  loadPolicies(): Promise<void>;
  addPolicy(input: { actionType: string; requireApproval?: boolean; maxAutoAmount?: number | null }): Promise<void>;
  removePolicy(ruleId: string): Promise<void>;
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

  // --- composer message/steering queue (#54) -------------------------------------------------
  // Per-channel queues live in state; the in-flight send is tracked here (not in state) so a single
  // drain serializes every send for a channel — re-entrant calls and edits never start a 2nd send.
  let queueSeq = 0;
  const draining = new Set<string>();

  function getQueue(channelId: string): SessionQueue {
    return state.queues[channelId] ?? emptyQueue();
  }

  function setQueue(channelId: string, q: SessionQueue): void {
    set({ queues: { ...state.queues, [channelId]: q } });
  }

  function newItem(text: string, kind: QueueItem["kind"]): QueueItem {
    queueSeq += 1;
    return { id: `q${queueSeq}`, text, kind };
  }

  /** Drain a channel's queue one message at a time. Holds while paused (an open edit) and exits on
   * empty; the `draining` guard makes the loop the single sender, so sends never overlap. */
  async function drain(channelId: string): Promise<void> {
    if (draining.has(channelId)) return;
    draining.add(channelId);
    try {
      for (;;) {
        const q = getQueue(channelId);
        if (q.status === "paused" || q.items.length === 0) break;
        const { head, rest } = takeHead(q);
        setQueue(channelId, rest); // the message leaves the visible queue as it goes in flight
        try {
          const msg = await api.postMessage(channelId, head.text);
          const list = state.messagesByChannel[channelId] ?? [];
          set({
            messagesByChannel: { ...state.messagesByChannel, [channelId]: upsertMessage(list, msg) },
          });
        } catch {
          // Best-effort: a failed send drops that message and the queue keeps draining.
        }
      }
    } finally {
      draining.delete(channelId);
    }
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
      default:
        // ready / subscribed / unsubscribed / error / pong — no UI state to update.
        break;
    }
  }

  function setApprovals(patch: Partial<ApprovalsState>): void {
    set({ approvals: { ...state.approvals, ...patch } });
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

    // --- composer message/steering queue (#54) ---

    queueMessage(text) {
      const channelId = state.activeChannelId;
      const body = text.trim();
      if (!channelId || !body) return;
      setQueue(channelId, enqueue(getQueue(channelId), newItem(body, "queue")));
      void drain(channelId);
    },

    steerMessage(text) {
      const channelId = state.activeChannelId;
      const body = text.trim();
      if (!channelId || !body) return;
      setQueue(channelId, enqueueSteer(getQueue(channelId), newItem(body, "steer")));
      void drain(channelId);
    },

    editQueuedStart(itemId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, beginEdit(getQueue(channelId), itemId));
    },

    editQueuedChange(text) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, editText(getQueue(channelId), text));
    },

    editQueuedCommit() {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, commitEdit(getQueue(channelId)));
      void drain(channelId);
    },

    editQueuedCancel() {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, cancelEdit(getQueue(channelId)));
      void drain(channelId);
    },

    removeQueued(itemId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, removeItem(getQueue(channelId), itemId));
      void drain(channelId);
    },

    moveQueued(itemId, dir) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setQueue(channelId, moveItem(getQueue(channelId), itemId, dir));
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
  };

  return store;
}
