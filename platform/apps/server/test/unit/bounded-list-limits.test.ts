import { describe, expect, it } from "vitest";
import {
  clampAutonomyListLimit,
  MAX_AUTONOMY_LIST_LIMIT,
} from "../../src/db/repositories/autonomy.js";
import {
  clampWorkspaceModelOverrideBatch,
  MAX_WORKSPACE_MODEL_OVERRIDE_BATCH,
} from "../../src/db/repositories/agent-credentials.js";
import {
  clampGovernanceInviteListLimit,
  MAX_GOVERNANCE_INVITE_LIST_LIMIT,
} from "../../src/db/repositories/governance.js";
import {
  clampMarketingTaskListLimit,
  MAX_MARKETING_TASK_LIST_LIMIT,
} from "../../src/db/repositories/marketing-tasks.js";
import {
  clampApprovalEventListLimit,
  MAX_APPROVAL_EVENT_LIST_LIMIT,
  clampApprovalRequestListLimit,
  MAX_APPROVAL_REQUEST_LIST_LIMIT,
} from "../../src/db/repositories/approvals.js";
import { clampMemoryListLimit, MAX_MEMORY_LIST_LIMIT } from "../../src/db/repositories/memories.js";
import { clampMessageReadLimit, MAX_MESSAGE_READ_LIMIT } from "../../src/db/repositories/messages.js";

describe("bounded list limits", () => {
  it("caps agent-readable message queries", () => {
    expect(clampMessageReadLimit()).toBe(MAX_MESSAGE_READ_LIMIT);
    expect(clampMessageReadLimit(25)).toBe(25);
    expect(clampMessageReadLimit(50_000)).toBe(MAX_MESSAGE_READ_LIMIT);
    expect(clampMessageReadLimit(-1)).toBe(MAX_MESSAGE_READ_LIMIT);
  });

  it("caps memory graph listings", () => {
    expect(clampMemoryListLimit()).toBe(MAX_MEMORY_LIST_LIMIT);
    expect(clampMemoryListLimit(250)).toBe(250);
    expect(clampMemoryListLimit(50_000)).toBe(MAX_MEMORY_LIST_LIMIT);
    expect(clampMemoryListLimit(Number.NaN)).toBe(MAX_MEMORY_LIST_LIMIT);
  });

  it("caps approval request listings", () => {
    expect(clampApprovalRequestListLimit()).toBe(MAX_APPROVAL_REQUEST_LIST_LIMIT);
    expect(clampApprovalRequestListLimit(100)).toBe(100);
    expect(clampApprovalRequestListLimit(50_000)).toBe(MAX_APPROVAL_REQUEST_LIST_LIMIT);
    expect(clampApprovalRequestListLimit(0)).toBe(MAX_APPROVAL_REQUEST_LIST_LIMIT);
  });

  it("caps approval event listings", () => {
    expect(clampApprovalEventListLimit()).toBe(MAX_APPROVAL_EVENT_LIST_LIMIT);
    expect(clampApprovalEventListLimit(100)).toBe(100);
    expect(clampApprovalEventListLimit(50_000)).toBe(MAX_APPROVAL_EVENT_LIST_LIMIT);
    expect(clampApprovalEventListLimit(0)).toBe(MAX_APPROVAL_EVENT_LIST_LIMIT);
  });

  it("caps autonomy workflow and approval listings", () => {
    expect(clampAutonomyListLimit()).toBe(MAX_AUTONOMY_LIST_LIMIT);
    expect(clampAutonomyListLimit(25)).toBe(25);
    expect(clampAutonomyListLimit(50_000)).toBe(MAX_AUTONOMY_LIST_LIMIT);
    expect(clampAutonomyListLimit(Number.NaN)).toBe(MAX_AUTONOMY_LIST_LIMIT);
  });

  it("caps marketing task listings", () => {
    expect(clampMarketingTaskListLimit()).toBe(MAX_MARKETING_TASK_LIST_LIMIT);
    expect(clampMarketingTaskListLimit(25)).toBe(25);
    expect(clampMarketingTaskListLimit(50_000)).toBe(MAX_MARKETING_TASK_LIST_LIMIT);
    expect(clampMarketingTaskListLimit(0)).toBe(MAX_MARKETING_TASK_LIST_LIMIT);
  });

  it("caps governance invite listings", () => {
    expect(clampGovernanceInviteListLimit()).toBe(MAX_GOVERNANCE_INVITE_LIST_LIMIT);
    expect(clampGovernanceInviteListLimit(25)).toBe(25);
    expect(clampGovernanceInviteListLimit(50_000)).toBe(MAX_GOVERNANCE_INVITE_LIST_LIMIT);
    expect(clampGovernanceInviteListLimit(-1)).toBe(MAX_GOVERNANCE_INVITE_LIST_LIMIT);
  });

  it("caps model override backfill batches", () => {
    expect(clampWorkspaceModelOverrideBatch()).toBe(MAX_WORKSPACE_MODEL_OVERRIDE_BATCH);
    expect(clampWorkspaceModelOverrideBatch(25)).toBe(25);
    expect(clampWorkspaceModelOverrideBatch(50_000)).toBe(MAX_WORKSPACE_MODEL_OVERRIDE_BATCH);
    expect(clampWorkspaceModelOverrideBatch(Number.NaN)).toBe(MAX_WORKSPACE_MODEL_OVERRIDE_BATCH);
  });
});
