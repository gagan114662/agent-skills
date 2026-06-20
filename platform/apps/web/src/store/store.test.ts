import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorLabel, createStore, upsertMessage, type StoreDeps } from "./store.js";
import { ApiError } from "../api/client.js";
import { makePolicy as pol, makeRequest as req } from "../test/approvals-fixtures.js";
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
    department: {
      view: vi.fn(async () => ({
        enabled: false,
        canManage: false,
        roster: [],
        rail: { humanCount: 1, agentCount: 1, decisionsCaptured: 0, summary: "1 human · 1 agent · 0 decisions captured" },
      })),
    },
    approvals: {
      list: vi.fn(async () => []),
      get: vi.fn(async (rid: string) => req({ id: rid })),
      events: vi.fn(async () => []),
      approve: vi.fn(async (rid: string) => ({ status: "executed" as const, result: {}, request: req({ id: rid }) })),
      reject: vi.fn(async (rid: string) => ({ status: "rejected" as const, request: req({ id: rid }) })),
      listPolicies: vi.fn(async () => []),
      upsertPolicy: vi.fn(async (_w: string, input: { actionType: string }) => pol({ id: "p1", actionType: input.actionType })),
      deletePolicy: vi.fn(async () => ({ ok: true }) as const),
      submitAction: vi.fn(async () => ({ status: "pending" as const, reason: "policy", request: req({ id: "r1" }) })),
    },
    review: {
      listSessions: vi.fn(async () => []),
      launchSession: vi.fn(async (_c, input) => ({
        id: "sess_new",
        status: "provisioning",
        runtime: "local",
        agentMemberId: input.agentMemberId,
        provider: null,
        model: null,
        effort: null,
        mode: null,
      })),
      diff: vi.fn(async (_c, sessionId, mode) => ({
        sessionId,
        branch: `agent/${sessionId}`,
        baseBranch: "main",
        mode,
        patch: "",
        files: [],
      })),
      listComments: vi.fn(async () => []),
      addComment: vi.fn(async (_c, _s, _i) => ({
        comment: rc({ id: "rc1" }),
      })),
      deliver: vi.fn(async () => ({ sessionId: "follow-up", deliveredCount: 0 })),
      listPullRequests: vi.fn(async () => []),
      createPullRequest: vi.fn(async (_c, _s, input) => ({ pullRequest: prDto({ title: input.title }) })),
      refreshChecks: vi.fn(async () => ({ checksStatus: "success" as const, runs: [] })),
      fixCi: vi.fn(async () => ({ sessionId: "fix-ci" })),
    },
    run: {
      start: vi.fn(async (_c, sessionId) => ({
        sessionId,
        status: "starting" as const,
        url: null,
        exitCode: null,
        error: null,
        logs: [],
      })),
      status: vi.fn(async (_c, sessionId) => ({
        sessionId,
        status: "idle" as const,
        url: null,
        exitCode: null,
        error: null,
        logs: [],
      })),
      stop: vi.fn(async () => ({ ok: true, stopped: true })),
      sendAnnotations: vi.fn(async (_c, _s, annotations) => ({
        sessionId: "follow-up-run",
        count: annotations.length,
      })),
    },
    deploy: {
      start: vi.fn(async (_c, sessionId) => ({
        id: "dep-1",
        sessionId,
        channelId: _c,
        provider: "dryrun",
        status: "ready" as const,
        url: "https://app.dryrun.reload.app",
        framework: "static",
        error: null,
        reason: "deploy",
        rolledBackFromId: null,
        logs: [],
        createdAt: new Date().toISOString(),
      })),
      status: vi.fn(async () => null),
      history: vi.fn(async () => []),
      rollback: vi.fn(async (_c, sessionId) => ({
        id: "dep-2",
        sessionId,
        channelId: _c,
        provider: "dryrun",
        status: "rolled_back" as const,
        url: "https://app.dryrun.reload.app",
        framework: "static",
        error: null,
        reason: "rollback",
        rolledBackFromId: "dep-0",
        logs: [],
        createdAt: new Date().toISOString(),
      })),
      scale: vi.fn(async () => ({ ok: true })),
    },
  };
  return { deps: { api, realtime: rt }, rt };
}

const rc = (over: { id: string }) => ({
  id: over.id,
  workspaceId: "w1",
  channelId: "c1",
  sessionId: "s1",
  pullRequestId: null,
  filePath: "src/a.ts",
  lineStart: null,
  lineEnd: null,
  body: "comment",
  authorMemberId: "me1",
  deliveredToSessionId: null,
  createdAt: "2026-06-09T00:00:00.000Z",
});

const prDto = (over: { title: string }) => ({
  id: "pr1",
  workspaceId: "w1",
  channelId: "c1",
  sessionId: "s1",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: over.title,
  body: null,
  draft: false,
  state: "open" as const,
  checksStatus: "unknown" as const,
  baseBranch: "main",
  headBranch: "agent/s1",
  provider: "gh" as const,
  createdByMemberId: "me1",
  createdAt: "2026-06-09T00:00:00.000Z",
  updatedAt: "2026-06-09T00:00:00.000Z",
});

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

  it("refreshChannelMessages upserts fetched messages without dropping a live arrival (#419)", async () => {
    const store = createStore(env.deps);
    await store.bootstrap(); // c1 has [m1]

    // A realtime message lands optimistically (the primary path).
    env.rt.fire({ type: "message", message: msg({ id: "live", channelId: "c1", body: "live arrival" }) });
    expect(store.getState().messagesByChannel.c1?.map((m) => m.id)).toEqual(["m1", "live"]);

    // The poll fallback re-fetches and returns the authoritative list (which now also includes m1, plus an edit
    // of m1). The upsert must merge — never clobber the not-yet-persisted "live" message.
    (env.deps.api.listMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      msg({ id: "m1", body: "edited" }),
    ]);
    await store.refreshChannelMessages("c1");

    const list = store.getState().messagesByChannel.c1 ?? [];
    expect(list.map((m) => m.id)).toEqual(["m1", "live"]);
    expect(list.find((m) => m.id === "m1")?.body).toBe("edited"); // the refetch updated m1 in place
  });

  it("refreshChannelMessages swallows a fetch error (best-effort fallback) (#419)", async () => {
    const store = createStore(env.deps);
    await store.bootstrap();
    (env.deps.api.listMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
    await expect(store.refreshChannelMessages("c1")).resolves.toBeUndefined();
    expect(store.getState().messagesByChannel.c1?.map((m) => m.id)).toEqual(["m1"]);
  });

  it("fans realtime events out to onRealtimeEvent subscribers and stops on unsubscribe (#362)", async () => {
    const store = createStore(env.deps);
    const seen: ServerEvent[] = [];
    const off = store.onRealtimeEvent((e) => seen.push(e));
    await store.bootstrap();

    env.rt.fire({ type: "run_status", sessionId: "s1", channelId: "c1", status: "running" });
    env.rt.fire({ type: "message", message: msg({ id: "m2", channelId: "c1" }) });
    expect(seen.map((e) => e.type)).toEqual(["run_status", "message"]);
    // The store still applied the events to its own state (fan-out is in addition, not instead).
    expect(store.getState().messagesByChannel.c1?.map((m) => m.id)).toEqual(["m1", "m2"]);

    off();
    env.rt.fire({ type: "run_status", sessionId: "s2", channelId: "c1", status: "running" });
    expect(seen).toHaveLength(2); // no further delivery after unsubscribe
  });

  it("a throwing onRealtimeEvent subscriber never breaks store state application (#362)", async () => {
    const store = createStore(env.deps);
    store.onRealtimeEvent(() => {
      throw new Error("subscriber blew up");
    });
    await store.bootstrap();

    env.rt.fire({ type: "message", message: msg({ id: "m2", channelId: "c1" }) });
    // Despite the throwing subscriber, the store still applied the message.
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

  it("#153 a hit cap (402) surfaces the soft paywall instead of throwing", async () => {
    env.deps.api.postMessage = vi.fn(async () => {
      throw new ApiError("budget exceeded", 402);
    });
    const store = createStore(env.deps);
    await store.bootstrap();
    expect(store.getState().paywall).toBe(false);

    await store.sendMessage("@quill draft a launch post"); // must not reject
    expect(store.getState().paywall).toBe(true);

    store.dismissPaywall();
    expect(store.getState().paywall).toBe(false);
  });

  it("#153 a non-cap error from sending still propagates", async () => {
    env.deps.api.postMessage = vi.fn(async () => {
      throw new ApiError("nope", 500);
    });
    const store = createStore(env.deps);
    await store.bootstrap();
    await expect(store.sendMessage("hi")).rejects.toThrow();
    expect(store.getState().paywall).toBe(false);
  });
});
