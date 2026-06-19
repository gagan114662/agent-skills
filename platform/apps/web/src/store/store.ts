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
  DeploymentDto,
  DiffMode,
  PreviewAnnotation,
  PullRequestDto,
  ReviewCommentDto,
  RunState,
  SessionDiff,
} from "@reload/shared";
import type { api as realApi, AddReviewCommentInput, CreatePrInput } from "../api/client.js";
import { isApiUnavailable, isCapHit } from "../api/client.js";
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
  AgentSessionSummary,
  Channel,
  Identity,
  MemberHit,
  MentionEvent,
  Message,
  PresenceStatus,
  ServerEvent,
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

/** The run slice (#56 Run tab). The active channel's sessions, the selected session's live run
 * process state (status + preview url + logs), and the annotations collected on the preview before
 * they're delivered to the agent. The run process state is ephemeral (server-side, not persisted). */
export interface RunTabState {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  /** The selected session's live run-process state, or null before a run is started/known. */
  process: RunState | null;
  /** Annotations dropped on the preview, collected client-side until delivered (#56 round trip). */
  annotations: PreviewAnnotation[];
  loading: boolean;
  error: string | null;
}

/** The deploy slice (#73 Deploy tab). The active channel's sessions, the selected session's latest
 * deployment (status + live URL + redacted logs), and its deployment history (the backup set). Unlike
 * the ephemeral run slice, a deployment is durable (persisted server-side) and survives a reload. */
export interface DeployTabState {
  sessions: AgentSessionSummary[];
  activeSessionId: string | null;
  /** The selected session's latest deployment, or null before one exists. */
  latest: DeploymentDto | null;
  /** Deployment history (newest first) — each row is an immutable, rollback-able deploy. */
  history: DeploymentDto[];
  loading: boolean;
  /** True while a deploy/redeploy/rollback is in flight (drives the button spinner). */
  busy: boolean;
  error: string | null;
}

export interface AppState {
  phase: "loading" | "anon" | "ready" | "offline";
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
  run: RunTabState;
  deploy: DeployTabState;
  /** Per-session (per-channel) composer message/steering queue (#54). Keyed by channelId so each
   * conversation keeps its own stack across channel switches. */
  queues: Record<string, SessionQueue>;
  error: string | null;
  /** #153 trial funnel: true when a tenant cap was hit (#71 402/429) → show the soft paywall nudge. */
  paywall: boolean;
  /**
   * #371 members-rail footer: how many #13 approval requests reached a human decision. Loaded best-effort
   * from `GET /me/department` on workspace load; 0 until then (humans/agents come from the directory).
   */
  decisionsCaptured: number;
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
    | "review"
    | "run"
    | "deploy"
  > & {
    /** #371 members-rail footer — only the read-only `view` is needed (the team roster + the rail). */
    department: Pick<typeof realApi.department, "view">;
  };
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

const INITIAL_RUN: RunTabState = {
  sessions: [],
  activeSessionId: null,
  process: null,
  annotations: [],
  loading: false,
  error: null,
};

const INITIAL_DEPLOY: DeployTabState = {
  sessions: [],
  activeSessionId: null,
  latest: null,
  history: [],
  loading: false,
  busy: false,
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
  run: INITIAL_RUN,
  deploy: INITIAL_DEPLOY,
  queues: {},
  error: null,
  paywall: false,
  decisionsCaptured: 0,
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
  /**
   * Subscribe to the realtime socket stream the store already consumes (#362). Returns an unsubscribe.
   * Fan-out ONLY — it never mutates store state — so a coordination component can refresh a view (e.g. the
   * #147 mission-control strip) the instant a relevant event lands, instead of waiting on a fixed poll.
   * Taps the store's single socket connection; it does not open a second one.
   */
  onRealtimeEvent(listener: (event: ServerEvent) => void): () => void;
  /** Read the saved composer draft for a channel (#168), or "" if none. Client-only, per-channel. */
  getDraft(channelId: string): string;
  /** Save (or clear, when empty) a channel's composer draft so switching channels preserves text (#168). */
  setDraft(channelId: string, text: string): void;
  sendMessage(body: string): Promise<void>;
  openThread(messageId: string): Promise<void>;
  closeThread(): void;
  sendReply(rootId: string, body: string, alsoSendToChannel: boolean): Promise<void>;
  searchMembers(query: string): Promise<MemberHit[]>;
  markMentionsRead(): void;
  // --- trial funnel soft paywall (#153) ---
  /** Surface the soft paywall nudge (called when a tenant cap is hit). */
  showPaywall(): void;
  /** Dismiss the soft paywall nudge. */
  dismissPaywall(): void;
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
  // --- git / PR / diff / review (#51 web surface) ---
  loadReview(): Promise<void>;
  selectReviewSession(sessionId: string): Promise<void>;
  setDiffMode(mode: DiffMode): Promise<void>;
  addReviewComment(input: AddReviewCommentInput): Promise<void>;
  deliverComments(): Promise<number>;
  createPullRequest(input: CreatePrInput): Promise<void>;
  refreshChecks(prId: string): Promise<void>;
  fixCi(prId: string): Promise<void>;
  // --- run tab / preview + annotations (#56 web surface) ---
  /** Load the active channel's sessions for the Run tab. */
  loadRun(): Promise<void>;
  /** Select a session and fetch its current run-process state. */
  selectRunSession(sessionId: string): Promise<void>;
  /** Start the selected session's run process (spawns the dev server → detects the preview url). */
  startRun(): Promise<void>;
  /** Stop the selected session's run process. */
  stopRun(): Promise<void>;
  /** Collect an annotation dropped on the preview (delivered later as a batch). */
  addAnnotation(annotation: PreviewAnnotation): void;
  /** Drop a collected annotation by index before delivery. */
  removeAnnotation(index: number): void;
  /** Deliver the collected annotations to the agent as a follow-up session. Returns the count. */
  deliverAnnotations(): Promise<number>;
  // --- deploy to a live url (#73 web surface) ---
  /** Load the active channel's sessions for the Deploy tab. */
  loadDeploy(): Promise<void>;
  /** Select a session and fetch its latest deployment + history. */
  selectDeploySession(sessionId: string): Promise<void>;
  /** Deploy (or redeploy) the selected session's app to a live URL. */
  deployApp(): Promise<void>;
  /** Roll back the selected session to its prior good deployment. */
  rollbackDeploy(): Promise<void>;
  /** Scale the selected session's deployment to `instances` (bounded server-side). */
  scaleDeploy(instances: number): Promise<void>;
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

  // Per-channel composer drafts (#168). Kept OUT of reactive `state` so a keystroke doesn't notify
  // the whole app; the composer reads its channel's draft when it (re)mounts on a channel switch.
  const drafts = new Map<string, string>();

  // External realtime subscribers (#362 live coordination feed). The store consumes the socket once (a
  // single `realtime.on(onEvent)` in loadWorkspace); `onEvent` re-emits every event to these listeners so a
  // view can react live (e.g. refetch the #147 mission-control strip) WITHOUT opening a second socket.
  const realtimeListeners = new Set<(event: ServerEvent) => void>();

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

  function onEvent(event: ServerEvent): void {
    applyEvent(event);
    // #362: fan the event out to live-coordination subscribers AFTER applying it to state, so a listener
    // that reads the store sees the update. A throwing listener must never break the socket pump.
    for (const l of realtimeListeners) {
      try {
        l(event);
      } catch {
        /* a faulty subscriber can't stall realtime delivery */
      }
    }
  }

  function applyEvent(event: ServerEvent): void {
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
      case "run_status": {
        // Update the live run-process state for the session currently shown in the Run tab.
        if (event.sessionId !== state.run.activeSessionId) break;
        const prev = state.run.process;
        setRun({
          process: {
            sessionId: event.sessionId,
            status: event.status,
            url: event.url ?? prev?.url ?? null,
            exitCode: event.exitCode ?? prev?.exitCode ?? null,
            error: event.error ?? prev?.error ?? null,
            logs: prev?.logs ?? [],
          },
        });
        break;
      }
      case "run_log": {
        if (event.sessionId !== state.run.activeSessionId || !state.run.process) break;
        const logs = [...state.run.process.logs, event.chunk].slice(-RUN_LOG_TAIL);
        setRun({ process: { ...state.run.process, logs } });
        break;
      }
      case "deploy_status": {
        // Update the live deployment for the session currently shown in the Deploy tab.
        if (event.sessionId !== state.deploy.activeSessionId || !state.deploy.latest) break;
        if (event.deploymentId !== state.deploy.latest.id) break;
        setDeploy({
          latest: {
            ...state.deploy.latest,
            status: event.status,
            url: event.url ?? state.deploy.latest.url,
            error: event.error ?? state.deploy.latest.error,
          },
        });
        break;
      }
      case "deploy_log": {
        if (event.sessionId !== state.deploy.activeSessionId || !state.deploy.latest) break;
        if (event.deploymentId !== state.deploy.latest.id) break;
        const logs = [...state.deploy.latest.logs, event.chunk].slice(-RUN_LOG_TAIL);
        setDeploy({ latest: { ...state.deploy.latest, logs } });
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

  function setRun(patch: Partial<RunTabState>): void {
    set({ run: { ...state.run, ...patch } });
  }

  function setDeploy(patch: Partial<DeployTabState>): void {
    set({ deploy: { ...state.deploy, ...patch } });
  }

  /** How many trailing log lines the Run tab keeps from a live stream (mirrors the server tail). */
  const RUN_LOG_TAIL = 200;

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
    // #371 members-rail footer: load the captured-decision count best-effort (humans/agents come from the
    // directory). A miss only leaves the footer's decisions count at 0 — never breaks the rail.
    api.department
      .view()
      .then((view) => set({ decisionsCaptured: view.rail.decisionsCaptured }))
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
      } catch (err) {
        // No backend wired (standalone deploy / API down) → show the "API not connected" state.
        // A real API answering "unauthorized" (or any other error) just means we need to sign in.
        set({ phase: isApiUnavailable(err) ? "offline" : "anon", identity: null });
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
      drafts.clear(); // never carry one tenant's unsent drafts into the next session (#168)
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

    onRealtimeEvent(listener) {
      realtimeListeners.add(listener);
      return () => realtimeListeners.delete(listener);
    },

    getDraft(channelId) {
      return drafts.get(channelId) ?? "";
    },

    setDraft(channelId, text) {
      if (text) drafts.set(channelId, text);
      else drafts.delete(channelId);
    },

    async sendMessage(body) {
      const channelId = state.activeChannelId;
      if (!channelId || !body.trim()) return;
      try {
        const msg = await api.postMessage(channelId, body);
        const list = state.messagesByChannel[channelId] ?? [];
        set({ messagesByChannel: { ...state.messagesByChannel, [channelId]: upsertMessage(list, msg) } });
      } catch (err) {
        // A hit cap (#71 402/429) becomes the soft paywall nudge (#153), not a raw error.
        if (isCapHit(err)) set({ paywall: true });
        else throw err;
      }
    },

    showPaywall() {
      set({ paywall: true });
    },

    dismissPaywall() {
      set({ paywall: false });
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
      let reply;
      try {
        reply = await api.postReply(channelId, rootId, body, alsoSendToChannel);
      } catch (err) {
        if (isCapHit(err)) {
          set({ paywall: true });
          return;
        }
        throw err;
      }
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

    // --- run tab / preview + annotations (#56) ---
    /** Load the active channel's sessions for the Run tab (reuses the #51 session list). */
    async loadRun() {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setRun({ loading: true, error: null });
      try {
        const sessions = await api.review.listSessions(channelId);
        setRun({ sessions, loading: false });
      } catch (e) {
        setRun({ loading: false, error: errMsg(e) });
      }
    },

    /** Select a session and fetch its current run-process state. */
    async selectRunSession(sessionId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setRun({ activeSessionId: sessionId, process: null, annotations: [], error: null });
      try {
        const process = await api.run.status(channelId, sessionId);
        // Guard against a race: only apply if this is still the selected session.
        if (state.run.activeSessionId === sessionId) setRun({ process });
      } catch (e) {
        setRun({ error: errMsg(e) });
      }
    },

    /** Start the selected session's run process. */
    async startRun() {
      const channelId = state.activeChannelId;
      const sessionId = state.run.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        const process = await api.run.start(channelId, sessionId);
        setRun({ process });
      } catch (e) {
        setRun({ error: errMsg(e) });
      }
    },

    /** Stop the selected session's run process. */
    async stopRun() {
      const channelId = state.activeChannelId;
      const sessionId = state.run.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        await api.run.stop(channelId, sessionId);
        const process = await api.run.status(channelId, sessionId);
        setRun({ process });
      } catch (e) {
        setRun({ error: errMsg(e) });
      }
    },

    addAnnotation(annotation) {
      setRun({ annotations: [...state.run.annotations, annotation] });
    },

    removeAnnotation(index) {
      setRun({ annotations: state.run.annotations.filter((_, i) => i !== index) });
    },

    /** Deliver the collected annotations to the agent as a follow-up session, then clear them. */
    async deliverAnnotations() {
      const channelId = state.activeChannelId;
      const sessionId = state.run.activeSessionId;
      if (!channelId || !sessionId || state.run.annotations.length === 0) return 0;
      try {
        const res = await api.run.sendAnnotations(channelId, sessionId, state.run.annotations);
        setRun({ annotations: [] });
        return res.count;
      } catch (e) {
        setRun({ error: errMsg(e) });
        return 0;
      }
    },

    // --- deploy to a live url (#73) ---
    /** Load the active channel's sessions for the Deploy tab (reuses the #51 session list). */
    async loadDeploy() {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setDeploy({ loading: true, error: null });
      try {
        const sessions = await api.review.listSessions(channelId);
        setDeploy({ sessions, loading: false });
      } catch (e) {
        setDeploy({ loading: false, error: errMsg(e) });
      }
    },

    /** Select a session and fetch its latest deployment + history. */
    async selectDeploySession(sessionId) {
      const channelId = state.activeChannelId;
      if (!channelId) return;
      setDeploy({ activeSessionId: sessionId, latest: null, history: [], error: null });
      try {
        const [latest, history] = await Promise.all([
          api.deploy.status(channelId, sessionId),
          api.deploy.history(channelId, sessionId),
        ]);
        // Guard against a race: only apply if this is still the selected session.
        if (state.deploy.activeSessionId === sessionId) setDeploy({ latest, history });
      } catch (e) {
        setDeploy({ error: errMsg(e) });
      }
    },

    /** Deploy (or redeploy) the selected session's app. */
    async deployApp() {
      const channelId = state.activeChannelId;
      const sessionId = state.deploy.activeSessionId;
      if (!channelId || !sessionId) return;
      setDeploy({ busy: true, error: null });
      try {
        const latest = await api.deploy.start(channelId, sessionId);
        const history = await api.deploy.history(channelId, sessionId);
        setDeploy({ latest, history, busy: false });
      } catch (e) {
        setDeploy({ busy: false, error: errMsg(e) });
      }
    },

    /** Roll back the selected session to its prior good deployment. */
    async rollbackDeploy() {
      const channelId = state.activeChannelId;
      const sessionId = state.deploy.activeSessionId;
      if (!channelId || !sessionId) return;
      setDeploy({ busy: true, error: null });
      try {
        const latest = await api.deploy.rollback(channelId, sessionId);
        const history = await api.deploy.history(channelId, sessionId);
        setDeploy({ latest, history, busy: false });
      } catch (e) {
        setDeploy({ busy: false, error: errMsg(e) });
      }
    },

    /** Scale the selected session's deployment to `instances` (bounded server-side). */
    async scaleDeploy(instances) {
      const channelId = state.activeChannelId;
      const sessionId = state.deploy.activeSessionId;
      if (!channelId || !sessionId) return;
      try {
        await api.deploy.scale(channelId, sessionId, instances);
      } catch (e) {
        setDeploy({ error: errMsg(e) });
      }
    },
  };

  return store;
}
