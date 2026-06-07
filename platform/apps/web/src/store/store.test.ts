import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorLabel, createStore, upsertMessage, type StoreDeps } from "./store.js";
import type { Realtime } from "../api/realtime.js";
import type { Identity, Message, ServerEvent } from "../api/types.js";

const msg = (over: Partial<Message> & { id: string }): Message => ({
  channelId: "c1",
  authorMemberId: "m1",
  parentMessageId: null,
  alsoSentToChannel: false,
  body: "hi",
  ...over,
});

describe("pure helpers", () => {
  it("upsertMessage appends new messages and replaces by id", () => {
    const a = msg({ id: "1", body: "a" });
    const b = msg({ id: "2", body: "b" });
    let list = upsertMessage([a], b);
    expect(list.map((m) => m.id)).toEqual(["1", "2"]);
    list = upsertMessage(list, msg({ id: "1", body: "edited" }));
    expect(list).toHaveLength(2);
    expect(list[0]!.body).toBe("edited");
  });

  it("authorLabel resolves a known member, else a short fallback", () => {
    const dir = { m1: { id: "m1", kind: "agent" as const, displayName: "Atlas" } };
    expect(authorLabel(dir, "m1")).toBe("Atlas");
    expect(authorLabel(dir, "m9quitelong")).toBe("member-m9quit");
  });
});

// --- integration with fake deps -------------------------------------------------------------

const identity: Identity = { workspaceId: "w1", memberId: "me1", kind: "human", displayName: "Ada" };

function fakeRealtime(): Realtime & { fire: (e: ServerEvent) => void } {
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

function fakeDeps(): { deps: StoreDeps; rt: ReturnType<typeof fakeRealtime> } {
  const rt = fakeRealtime();
  const api: StoreDeps["api"] = {
    me: vi.fn(async () => identity),
    login: vi.fn(async () => ({ ok: true }) as const),
    signup: vi.fn(async () => ({ ok: true }) as const),
    logout: vi.fn(async () => ({ ok: true }) as const),
    listChannels: vi.fn(async () => [
      { id: "c1", workspaceId: "w1", kind: "public" as const, name: "general", isArchived: false },
      { id: "c2", workspaceId: "w1", kind: "public" as const, name: "random", isArchived: false },
    ]),
    createChannel: vi.fn(async (_w, name) => ({
      id: "c3",
      workspaceId: "w1",
      kind: "public" as const,
      name,
      isArchived: false,
    })),
    listMessages: vi.fn(async () => [msg({ id: "m1" })]),
    postMessage: vi.fn(async (channelId, body) => msg({ id: "posted", channelId, body })),
    getThread: vi.fn(async () => ({ root: msg({ id: "m1" }), replies: [], replyCount: 0 })),
    postReply: vi.fn(async (channelId, rootId, body) =>
      msg({ id: "reply", channelId, parentMessageId: rootId, body }),
    ),
    searchMembers: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    listMyMentions: vi.fn(async () => []),
  };
  return { deps: { api, realtime: rt }, rt };
}

describe("store bootstrap + realtime", () => {
  let env: ReturnType<typeof fakeDeps>;
  beforeEach(() => {
    env = fakeDeps();
  });

  it("an authenticated bootstrap loads channels, selects the first, and subscribes", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();

    const s = store.getState();
    expect(s.phase).toBe("ready");
    expect(s.identity).toEqual(identity);
    expect(s.channels).toHaveLength(2);
    expect(s.activeChannelId).toBe("c1");
    expect(s.messagesByChannel.c1?.map((m) => m.id)).toEqual(["m1"]);
    expect(env.deps.realtime.connect).toHaveBeenCalled();
    expect(env.deps.realtime.subscribe).toHaveBeenCalledWith("c1");
    // self is seeded into the directory
    expect(authorLabel(s.directory, "me1")).toBe("Ada");
  });

  it("goes anonymous when /me is unauthorized", async () => {
    (env.deps.api.me as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("unauthorized"), { name: "ApiError", status: 401 }),
    );
    const store = createStore(env.deps);
    await store.bootstrap();
    expect(store.getState().phase).toBe("anon");
  });

  it("appends realtime messages to the right channel and de-dupes", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();

    env.rt.fire({ type: "message", message: msg({ id: "m2", channelId: "c1" }) });
    env.rt.fire({ type: "message", message: msg({ id: "m2", channelId: "c1" }) }); // dup

    expect(store.getState().messagesByChannel.c1?.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("records mention events into the inbox with an unread count", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();

    env.rt.fire({
      type: "mention",
      mention: {
        id: "x1",
        messageId: "m2",
        channelId: "c1",
        mentionedMemberId: "me1",
        authorMemberId: "other",
        body: "@Ada look",
      },
    });

    expect(store.getState().unreadMentions).toBe(1);
    expect(store.getState().mentions).toHaveLength(1);
    store.markMentionsRead();
    expect(store.getState().unreadMentions).toBe(0);
  });

  it("tracks presence updates from the gateway", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();
    env.rt.fire({ type: "presence", memberId: "u9", status: "online" });
    expect(store.getState().presence.u9).toBe("online");
  });

  it("sendMessage posts and a realtime echo does not duplicate it", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();

    await store.sendMessage("hello");
    const posted = store.getState().messagesByChannel.c1?.find((m) => m.id === "posted");
    expect(posted?.body).toBe("hello");

    env.rt.fire({ type: "message", message: msg({ id: "posted", channelId: "c1", body: "hello" }) });
    const count = store.getState().messagesByChannel.c1?.filter((m) => m.id === "posted").length;
    expect(count).toBe(1);
  });

  it("notifies subscribers on state change", async () => {
    const store = createStore(env.deps);
    const cb = vi.fn();
    store.subscribe(cb);
    await store.bootstrap();
    expect(cb).toHaveBeenCalled();
  });
});
