/** Shared test helpers: a configurable fake store backend + a render-with-provider wrapper. */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { Realtime } from "../api/realtime.js";
import type { Channel, Identity, MemberHit, Message, ServerEvent } from "../api/types.js";
import { createStore, type Store, type StoreDeps } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";

export const TEST_IDENTITY: Identity = {
  workspaceId: "w1",
  memberId: "me1",
  kind: "human",
  displayName: "Ada",
};

export function makeMessage(over: Partial<Message> & { id: string }): Message {
  return {
    channelId: "c1",
    authorMemberId: "me1",
    parentMessageId: null,
    alsoSentToChannel: false,
    body: "hi",
    ...over,
  };
}

export function fakeRealtime(): Realtime & { fire: (e: ServerEvent) => void } {
  let listener: ((e: ServerEvent) => void) | null = null;
  return {
    connect: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    presence: vi.fn(),
    on: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    fire: (e) => listener?.(e),
  };
}

const DEFAULT_CHANNELS: Channel[] = [
  { id: "c1", workspaceId: "w1", kind: "public", name: "general", isArchived: false },
  { id: "c2", workspaceId: "w1", kind: "public", name: "random", isArchived: false },
];

const DEFAULT_MEMBERS: MemberHit[] = [
  { id: "me1", kind: "human", displayName: "Ada" },
  { id: "ag1", kind: "agent", displayName: "Atlas" },
];

export interface FakeBackendOverrides {
  me?: () => Promise<Identity>;
  channels?: Channel[];
  messages?: Message[];
  members?: MemberHit[];
}

export function makeFakeDeps(over: FakeBackendOverrides = {}): {
  deps: StoreDeps;
  rt: ReturnType<typeof fakeRealtime>;
} {
  const rt = fakeRealtime();
  const members = over.members ?? DEFAULT_MEMBERS;
  const api: StoreDeps["api"] = {
    me: vi.fn(over.me ?? (async () => TEST_IDENTITY)),
    login: vi.fn(async () => ({ ok: true }) as const),
    signup: vi.fn(async () => ({ ok: true }) as const),
    logout: vi.fn(async () => ({ ok: true }) as const),
    listChannels: vi.fn(async () => over.channels ?? DEFAULT_CHANNELS),
    createChannel: vi.fn(async (_w, name) => ({
      id: "c3",
      workspaceId: "w1",
      kind: "public" as const,
      name,
      isArchived: false,
    })),
    listMessages: vi.fn(async () => over.messages ?? [makeMessage({ id: "m1", body: "first post" })]),
    postMessage: vi.fn(async (channelId, body) => makeMessage({ id: `p-${body}`, channelId, body })),
    getThread: vi.fn(async () => ({
      root: makeMessage({ id: "m1", body: "first post" }),
      replies: [],
      replyCount: 0,
    })),
    postReply: vi.fn(async (channelId, rootId, body) =>
      makeMessage({ id: `r-${body}`, channelId, parentMessageId: rootId, body }),
    ),
    searchMembers: vi.fn(async (_w, q) =>
      members.filter((m) => m.displayName.toLowerCase().includes(q.toLowerCase())),
    ),
    listAgents: vi.fn(async () => [
      { id: "ag1", name: "Atlas", framework: "claude", ownerUserId: null, deactivatedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    ]),
    listMyMentions: vi.fn(async () => []),
  };
  return { deps: { api, realtime: rt }, rt };
}

/** Render `ui` inside a StoreProvider backed by a fake store; returns the store + realtime handle. */
export function renderWithStore(
  ui: ReactNode,
  over: FakeBackendOverrides = {},
): RenderResult & { store: Store; rt: ReturnType<typeof fakeRealtime> } {
  const { deps, rt } = makeFakeDeps(over);
  const store = createStore(deps);
  const result = render(<StoreProvider store={store}>{ui}</StoreProvider>);
  return { ...result, store, rt };
}
