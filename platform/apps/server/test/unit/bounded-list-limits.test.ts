import { describe, expect, it } from "vitest";
import {
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
});
