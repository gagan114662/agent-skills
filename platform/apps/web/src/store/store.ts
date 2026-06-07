/**
 * The single in-memory app store. Holds all UI state, orchestrates REST + realtime, and exposes a
 * `useSyncExternalStore`-compatible `subscribe`/`getState` pair. No router, no Redux — one store.
 *
 * State is immutable: every mutation replaces `state` with a new object so `getState()` returns a
 * stable reference between notifications (what `useSyncExternalStore` requires).
 */
import type { api as realApi } from "../api/client.js";
import type { Realtime } from "../api/realtime.js";
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
      case "presence":
        set({ presence: { ...state.presence, [event.memberId]: event.status } });
        break;
      default:
        // ready / subscribed / unsubscribed / error / pong — no UI state to update.
        break;
    }
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
  };

  return store;
}
