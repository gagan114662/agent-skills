import { describe, it, expect } from "vitest";
import {
  preflight,
  guardDisaster,
  DisasterNotApproved,
  type PreflightInput,
} from "../../src/dr/runbook.js";
import { DR_RESTORE_ACTION } from "../../src/approvals/policy.js";

const OK: PreflightInput = {
  credsPresent: true,
  dumpPresent: true,
  dumpBytes: 4096,
  dumpAgeMs: 60_000,
  maxDumpAgeMs: 3_600_000,
};

describe("preflight (abort with no outage, BEFORE any maintenance flip)", () => {
  it("proceeds when creds + a fresh non-empty dump are present", () => {
    expect(preflight(OK)).toEqual({ proceed: true });
  });

  it("aborts when the bucket credentials are missing", () => {
    const r = preflight({ ...OK, credsPresent: false });
    expect(r.proceed).toBe(false);
    expect(r.abort).toMatch(/cred/i);
  });

  it("aborts when there is no dump, or the dump is zero bytes", () => {
    expect(preflight({ ...OK, dumpPresent: false }).proceed).toBe(false);
    expect(preflight({ ...OK, dumpBytes: 0 }).proceed).toBe(false);
  });

  it("aborts when the latest dump is older than the freshness bound", () => {
    const r = preflight({ ...OK, dumpAgeMs: 7_200_000 });
    expect(r.proceed).toBe(false);
    expect(r.abort).toMatch(/stale|old/i);
  });

  it("tolerates an unknown dump age (null) — freshness is enforced only when known", () => {
    expect(preflight({ ...OK, dumpAgeMs: null }).proceed).toBe(true);
  });
});

describe("guardDisaster (DISASTER requires explicit #13 approval, never agent-initiated)", () => {
  it("lets VALIDATION through with no approval (it is non-destructive)", () => {
    expect(() => guardDisaster("validation")).not.toThrow();
    expect(() => guardDisaster("validation", null)).not.toThrow();
  });

  it("throws for DISASTER with no approval", () => {
    expect(() => guardDisaster("disaster")).toThrow(DisasterNotApproved);
    expect(() => guardDisaster("disaster", null)).toThrow(DisasterNotApproved);
  });

  it("throws for DISASTER with a pending (not-yet-approved) gate", () => {
    expect(() => guardDisaster("disaster", { action: DR_RESTORE_ACTION, status: "pending" })).toThrow(
      DisasterNotApproved,
    );
  });

  it("throws for DISASTER when the approval is for a different action", () => {
    expect(() => guardDisaster("disaster", { action: "external.send", status: "approved" })).toThrow(
      DisasterNotApproved,
    );
  });

  it("accepts DISASTER with an approved dr.restore gate", () => {
    expect(() =>
      guardDisaster("disaster", { action: DR_RESTORE_ACTION, status: "approved" }),
    ).not.toThrow();
  });
});
