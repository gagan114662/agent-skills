/**
 * Test fixtures for the approvals slice: DTO builders + a controllable fake approval backend whose
 * canned data can be mutated between calls (to simulate the server state changing after a decision
 * or a live notification). Built on top of `makeFakeDeps` so bootstrap still works end to end.
 */
import { vi } from "vitest";
import type {
  ApprovalEventDto,
  ApprovalPolicyDto,
  ApprovalRequestDto,
  ApprovalStatus,
} from "@reload/shared";
import { makeFakeDeps } from "./utils.js";

export function makeRequest(over: Partial<ApprovalRequestDto> & { id: string }): ApprovalRequestDto {
  return {
    workspaceId: "w1",
    requesterMemberId: "ag1",
    actionType: "external.send",
    payload: { to: "ops@example.com", body: "wire $250" },
    amount: 250,
    summary: "Send external message to ops@example.com",
    status: "pending",
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: "2026-06-08T13:00:00Z",
    result: null,
    error: null,
    createdAt: "2026-06-08T11:00:00Z",
    updatedAt: "2026-06-08T11:00:00Z",
    ...over,
  };
}

export function makePolicy(over: Partial<ApprovalPolicyDto> & { id: string }): ApprovalPolicyDto {
  return {
    actionType: "chat.post_message",
    requireApproval: true,
    maxAutoAmount: null,
    createdAt: "2026-06-08T10:00:00Z",
    updatedAt: "2026-06-08T10:00:00Z",
    ...over,
  };
}

export interface ApprovalFixtureOverrides {
  pending?: ApprovalRequestDto[];
  executed?: ApprovalRequestDto[];
  rejected?: ApprovalRequestDto[];
  expired?: ApprovalRequestDto[];
  detail?: ApprovalRequestDto;
  events?: ApprovalEventDto[];
  policies?: ApprovalPolicyDto[];
}

/** A fake `api.approvals` with mutable state and spies, plus setters to evolve server state. */
export function makeApprovalsFake(over: ApprovalFixtureOverrides = {}) {
  const byStatus: Record<ApprovalStatus, ApprovalRequestDto[]> = {
    pending: over.pending ?? [],
    approved: [],
    executed: over.executed ?? [],
    failed: [],
    rejected: over.rejected ?? [],
    expired: over.expired ?? [],
  };
  let policies = over.policies ?? [];
  const detail = over.detail ?? null;
  const events = over.events ?? [];

  const fake = {
    list: vi.fn(async (_wid: string, status?: string): Promise<ApprovalRequestDto[]> => {
      if (!status) return Object.values(byStatus).flat();
      return byStatus[status as ApprovalStatus] ?? [];
    }),
    get: vi.fn(async (rid: string): Promise<ApprovalRequestDto> => detail ?? makeRequest({ id: rid })),
    events: vi.fn(async (): Promise<ApprovalEventDto[]> => events),
    approve: vi.fn(async (rid: string) => ({
      status: "executed" as const,
      result: {},
      request: makeRequest({ id: rid, status: "executed" }),
    })),
    reject: vi.fn(async (rid: string, reason: string) => ({
      status: "rejected" as const,
      request: makeRequest({ id: rid, status: "rejected", reason }),
    })),
    listPolicies: vi.fn(async (): Promise<ApprovalPolicyDto[]> => policies),
    upsertPolicy: vi.fn(async (_wid: string, input: { actionType: string }) =>
      makePolicy({ id: "new", actionType: input.actionType }),
    ),
    deletePolicy: vi.fn(async () => ({ ok: true }) as const),
    submitAction: vi.fn(async () => ({
      status: "pending" as const,
      reason: "policy",
      request: makeRequest({ id: "r1" }),
    })),
    // --- test setters (not part of the api surface) ---
    setPending(rs: ApprovalRequestDto[]): void {
      byStatus.pending = rs;
    },
    setStatus(status: ApprovalStatus, rs: ApprovalRequestDto[]): void {
      byStatus[status] = rs;
    },
    setPolicies(ps: ApprovalPolicyDto[]): void {
      policies = ps;
    },
  };
  return fake;
}

/** Full deps with a controllable approvals backend; returns the fake so tests can evolve it. */
export function makeFakeApprovalDeps(over: ApprovalFixtureOverrides = {}): {
  deps: ReturnType<typeof makeFakeDeps>["deps"];
  rt: ReturnType<typeof makeFakeDeps>["rt"];
  approvals: ReturnType<typeof makeApprovalsFake>;
} {
  const { deps, rt } = makeFakeDeps();
  const approvals = makeApprovalsFake(over);
  deps.api.approvals = approvals;
  return { deps, rt, approvals };
}
