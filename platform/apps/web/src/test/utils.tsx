/** Shared test helpers: a configurable fake store backend + a render-with-provider wrapper. */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { ApprovalPolicyDto, ApprovalRequestDto } from "@reload/shared";
import type { Realtime } from "../api/realtime.js";
import type {
  AgentSessionSummary,
  Channel,
  Identity,
  MemberHit,
  Message,
  ServerEvent,
} from "../api/types.js";
import { createStore, type Store, type StoreDeps } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";

const STUB_REQUEST: ApprovalRequestDto = {
  id: "r0",
  workspaceId: "w1",
  requesterMemberId: "ag1",
  actionType: "external.send",
  payload: {},
  amount: null,
  summary: "stub request",
  status: "pending",
  reason: null,
  decidedByMemberId: null,
  decidedAt: null,
  expiresAt: null,
  result: null,
  error: null,
  createdAt: "2026-06-08T11:00:00Z",
  updatedAt: "2026-06-08T11:00:00Z",
};

const STUB_POLICY: ApprovalPolicyDto = {
  id: "p0",
  actionType: "chat.post_message",
  requireApproval: true,
  maxAutoAmount: null,
  createdAt: "2026-06-08T10:00:00Z",
  updatedAt: "2026-06-08T10:00:00Z",
};

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
  sessions?: AgentSessionSummary[];
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
    department: {
      view: vi.fn(async () => ({
        enabled: false,
        canManage: false,
        roster: [],
        rail: {
          humanCount: 1,
          agentCount: 1,
          decisionsCaptured: 0,
          summary: "1 human · 1 agent · 0 decisions captured",
        },
      })),
    },
    approvals: {
      list: vi.fn(async () => [] as ApprovalRequestDto[]),
      get: vi.fn(async () => STUB_REQUEST),
      events: vi.fn(async () => []),
      approve: vi.fn(async (rid: string) => ({ status: "executed" as const, result: {}, request: { ...STUB_REQUEST, id: rid, status: "executed" as const } })),
      reject: vi.fn(async (rid: string, reason: string) => ({ status: "rejected" as const, request: { ...STUB_REQUEST, id: rid, status: "rejected" as const, reason } })),
      listPolicies: vi.fn(async () => [] as ApprovalPolicyDto[]),
      upsertPolicy: vi.fn(async (_w: string, input: { actionType: string }) => ({ ...STUB_POLICY, actionType: input.actionType })),
      deletePolicy: vi.fn(async () => ({ ok: true }) as const),
      submitAction: vi.fn(async () => ({ status: "pending" as const, reason: "policy", request: STUB_REQUEST })),
    },
    review: {
      listSessions: vi.fn(async () => over.sessions ?? []),
      launchSession: vi.fn(async (_c: string, input: { agentMemberId: string }) => ({
        id: "sess_new",
        status: "provisioning",
        runtime: "local",
        agentMemberId: input.agentMemberId,
        provider: null,
        model: null,
        effort: null,
        mode: null,
      })),
      diff: vi.fn(async (_c: string, sessionId: string, mode: "cumulative" | "turn") => ({
        sessionId,
        branch: `agent/${sessionId}`,
        baseBranch: "main",
        mode,
        patch: "",
        files: [],
      })),
      listComments: vi.fn(async () => []),
      addComment: vi.fn(async (_c: string, sessionId: string, input: { filePath: string; body: string }) => ({
        comment: {
          id: `rc-${input.filePath}`,
          workspaceId: "w1",
          channelId: _c,
          sessionId,
          pullRequestId: null,
          filePath: input.filePath,
          lineStart: null,
          lineEnd: null,
          body: input.body,
          authorMemberId: "me1",
          deliveredToSessionId: null,
          createdAt: "2026-06-09T00:00:00.000Z",
        },
      })),
      deliver: vi.fn(async () => ({ sessionId: "follow-up", deliveredCount: 1 })),
      listPullRequests: vi.fn(async () => []),
      createPullRequest: vi.fn(async (_c: string, sessionId: string, input: { title: string }) => ({
        pullRequest: {
          id: "pr1",
          workspaceId: "w1",
          channelId: _c,
          sessionId,
          number: 1,
          url: "https://github.com/o/r/pull/1",
          title: input.title,
          body: null,
          draft: false,
          state: "open" as const,
          checksStatus: "unknown" as const,
          baseBranch: "main",
          headBranch: `agent/${sessionId}`,
          provider: "gh" as const,
          createdByMemberId: "me1",
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-09T00:00:00.000Z",
        },
      })),
      refreshChecks: vi.fn(async () => ({ checksStatus: "success" as const, runs: [] })),
      fixCi: vi.fn(async () => ({ sessionId: "fix-ci" })),
    },
    run: {
      start: vi.fn(async (_c: string, sessionId: string) => ({
        sessionId,
        status: "starting" as const,
        url: null,
        exitCode: null,
        error: null,
        logs: [],
      })),
      status: vi.fn(async (_c: string, sessionId: string) => ({
        sessionId,
        status: "idle" as const,
        url: null,
        exitCode: null,
        error: null,
        logs: [],
      })),
      stop: vi.fn(async () => ({ ok: true, stopped: true })),
      sendAnnotations: vi.fn(async (_c: string, _s: string, annotations: { note: string }[]) => ({
        sessionId: "follow-up-run",
        count: annotations.length,
      })),
    },
    deploy: {
      start: vi.fn(async (_c: string, sessionId: string) => ({
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
      rollback: vi.fn(async (_c: string, sessionId: string) => ({
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
