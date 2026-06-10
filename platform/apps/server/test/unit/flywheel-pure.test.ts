import { describe, it, expect } from "vitest";
import { fingerprintFailure, normalizeMessage } from "../../src/flywheel/fingerprint.js";
import { resolveFlywheelCaps, FLYWHEEL_DEFAULTS } from "../../src/flywheel/caps.js";
import {
  aboveThreshold,
  concurrencyAvailable,
  hasNewOccurrences,
  withinRateLimit,
} from "../../src/flywheel/guards.js";
import { decideIssueAction, decideDispatch } from "../../src/flywheel/decide.js";
import { rankFingerprints } from "../../src/flywheel/rank.js";
import { buildSampleContext, renderIssueBody, renderFixTask } from "../../src/flywheel/render.js";
import { makeRedactor } from "../../src/runtime/redact.js";
import type { FingerprintRecord } from "../../src/flywheel/types.js";

/** A baseline fingerprint with no issue yet, one occurrence. Override per-case. */
function fp(over: Partial<FingerprintRecord> = {}): FingerprintRecord {
  return {
    id: "fp-1",
    workspaceId: "w-1",
    signature: "abc123",
    failureClass: "harness_crash",
    title: "[flywheel:harness_crash] boom",
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    lastSeenAt: new Date("2026-06-01T00:00:00Z"),
    occurrenceCount: 1,
    sampleContext: JSON.stringify({ message: "boom" }),
    status: "open",
    originChannelId: null,
    originAgentMemberId: null,
    issueRef: null,
    issueState: null,
    syncedOccurrenceCount: 0,
    fixSessionId: null,
    fixRef: null,
    fixedAt: null,
    excludedFromAutoDispatch: false,
    escalated: false,
    ...over,
  };
}

describe("fingerprintFailure (#117 dedup key)", () => {
  it("collapses volatile ids so two incarnations of the same bug share a signature", () => {
    const a = fingerprintFailure({
      failureClass: "harness_crash",
      message: "session 3f2504e0-4f89-41d3-9a0c-0305e82c3301 crashed at app.ts:128:9",
    });
    const b = fingerprintFailure({
      failureClass: "harness_crash",
      message: "session 7c9e6679-7425-40de-944b-e07fc1f90ae7 crashed at app.ts:992:4",
    });
    expect(a.signature).toBe(b.signature);
  });

  it("separates identical messages from different classes (different repro/fix)", () => {
    const a = fingerprintFailure({ failureClass: "harness_crash", message: "timeout" });
    const b = fingerprintFailure({ failureClass: "ci_fail", message: "timeout" });
    expect(a.signature).not.toBe(b.signature);
  });

  it("derives a class-tagged, capped title", () => {
    const { title } = fingerprintFailure({ failureClass: "ci_fail", message: "build broke\nmore" });
    expect(title).toContain("[flywheel:ci_fail]");
    expect(title).toContain("build broke");
    expect(title).not.toContain("more"); // only the first line
  });

  it("normalizeMessage strips uuids, hex, numbers, timestamps", () => {
    const n = normalizeMessage("Err 0xDEADBEEF at 2026-06-01T00:00:00Z code 42");
    expect(n).not.toMatch(/0xdeadbeef/);
    expect(n).not.toMatch(/42/);
    expect(n).toContain("<hex>");
    expect(n).toContain("<n>");
  });
});

describe("resolveFlywheelCaps", () => {
  it("is default-OFF with sane bounds", () => {
    const caps = resolveFlywheelCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps).toEqual(FLYWHEEL_DEFAULTS);
  });
  it("overrides only provided fields", () => {
    const caps = resolveFlywheelCaps({ enabled: true, maxConcurrentFixes: 5 });
    expect(caps.enabled).toBe(true);
    expect(caps.maxConcurrentFixes).toBe(5);
    expect(caps.issueThreshold).toBe(FLYWHEEL_DEFAULTS.issueThreshold);
  });
});

describe("guards", () => {
  it("aboveThreshold respects a 0 threshold as never", () => {
    expect(aboveThreshold(5, 0)).toBe(false);
    expect(aboveThreshold(1, 1)).toBe(true);
  });
  it("hasNewOccurrences only when count moved past the sync point", () => {
    expect(hasNewOccurrences(3, 3)).toBe(false);
    expect(hasNewOccurrences(4, 3)).toBe(true);
  });
  it("concurrencyAvailable respects the hard cap (0 = never)", () => {
    expect(concurrencyAvailable(0, 0)).toBe(false);
    expect(concurrencyAvailable(1, 1)).toBe(false);
    expect(concurrencyAvailable(0, 1)).toBe(true);
  });
  it("withinRateLimit bounds issue creation per tick", () => {
    expect(withinRateLimit(3, 3)).toBe(false);
    expect(withinRateLimit(2, 3)).toBe(true);
  });
});

describe("decideIssueAction (ONE open issue per fingerprint)", () => {
  const caps = resolveFlywheelCaps({ enabled: true });

  it("DRAFTs a new fingerprint over threshold with no issue", () => {
    expect(decideIssueAction(fp({ occurrenceCount: 1 }), caps).action).toBe("draft");
  });
  it("NOOPs a below-threshold fingerprint", () => {
    const strict = resolveFlywheelCaps({ enabled: true, issueThreshold: 5 });
    expect(decideIssueAction(fp({ occurrenceCount: 2 }), strict).action).toBe("noop");
  });
  it("COMMENTs (not duplicates) on an open issue with new occurrences", () => {
    const d = decideIssueAction(
      fp({ issueRef: "github:a/b#1", issueState: "open", occurrenceCount: 4, syncedOccurrenceCount: 1 }),
      caps,
    );
    expect(d.action).toBe("comment");
  });
  it("REOPENs a recurred-after-fix fingerprint that has an issue", () => {
    const d = decideIssueAction(fp({ status: "recurred", issueRef: "github:a/b#1", issueState: "closed" }), caps);
    expect(d.action).toBe("reopen");
    expect(d.reason).toBe("recurrence_after_fix");
  });
  it("NOOPs an already-synced open issue", () => {
    const d = decideIssueAction(
      fp({ issueRef: "github:a/b#1", issueState: "open", occurrenceCount: 2, syncedOccurrenceCount: 2 }),
      caps,
    );
    expect(d.action).toBe("noop");
  });
});

describe("decideDispatch (sensitive-by-default, triple-bounded)", () => {
  const base = {
    excludedFromAutoDispatch: false,
    autoAllowed: true,
    budgetExhausted: false,
    concurrencyAvailable: true,
  };
  it("AUTO when allowed, in-budget, with headroom", () => {
    expect(decideDispatch(base).action).toBe("auto");
  });
  it("SKIPs the auto path (budget) when over the dollar ceiling", () => {
    expect(decideDispatch({ ...base, budgetExhausted: true }).action).toBe("skip");
    expect(decideDispatch({ ...base, budgetExhausted: true }).reason).toBe("budget_exhausted");
  });
  it("SKIPs the auto path (concurrency cap) when no headroom", () => {
    expect(decideDispatch({ ...base, concurrencyAvailable: false }).reason).toBe("concurrency_cap");
  });
  it("QUEUEs a recurred-after-fix fingerprint even if auto-allowed AND over budget / at cap", () => {
    // The route is decided first: a fix that already failed once ALWAYS goes to a human, regardless of
    // the spend/concurrency caps (queueing consumes no session slot).
    const d = decideDispatch({
      ...base,
      excludedFromAutoDispatch: true,
      budgetExhausted: true,
      concurrencyAvailable: false,
    });
    expect(d.action).toBe("queue");
    expect(d.reason).toBe("recurred_after_fix");
  });
  it("QUEUEs a class with no auto-approve policy rule (even at the concurrency cap)", () => {
    const d = decideDispatch({ ...base, autoAllowed: false, concurrencyAvailable: false });
    expect(d.action).toBe("queue");
    expect(d.reason).toBe("policy_requires_approval");
  });
});

describe("rankFingerprints", () => {
  it("orders by occurrences desc, then recency", () => {
    const a = fp({ id: "a", occurrenceCount: 2, lastSeenAt: new Date("2026-06-01") });
    const b = fp({ id: "b", occurrenceCount: 5, lastSeenAt: new Date("2026-06-01") });
    const c = fp({ id: "c", occurrenceCount: 2, lastSeenAt: new Date("2026-06-09") });
    expect(rankFingerprints([a, b, c]).map((f) => f.id)).toEqual(["b", "c", "a"]);
  });
});

describe("render (redacted fields only — the safety invariant)", () => {
  it("buildSampleContext scrubs secrets before they are ever persisted", () => {
    const redact = makeRedactor({ TOKEN: "super-secret-value-123" });
    const sample = buildSampleContext(
      { message: "auth failed with token super-secret-value-123", source: "harness" },
      redact,
    );
    expect(sample).not.toContain("super-secret-value-123");
    expect(sample).toContain("‹redacted›");
  });

  it("the issue body and fix task only echo the already-redacted sample", () => {
    const redact = makeRedactor({ TOKEN: "super-secret-value-123" });
    const sample = buildSampleContext({ message: "boom super-secret-value-123", detail: "stack" }, redact);
    const record = fp({ sampleContext: sample, occurrenceCount: 3, issueRef: "github:a/b#1" });
    expect(renderIssueBody(record)).not.toContain("super-secret-value-123");
    expect(renderIssueBody(record)).toContain("Acceptance criteria");
    expect(renderFixTask(record)).not.toContain("super-secret-value-123");
  });
});
