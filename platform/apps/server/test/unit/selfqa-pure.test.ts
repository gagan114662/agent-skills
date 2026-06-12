import { describe, it, expect } from "vitest";
import { QA_CATALOG, checksForSuite, getCheck } from "../../src/selfqa/catalog.js";
import { classifyResults } from "../../src/selfqa/classify.js";
import { fingerprintFinding, normalizeActual } from "../../src/selfqa/fingerprint.js";
import {
  renderFindingTitle,
  findingLabels,
  renderFindingBody,
  renderRecurrenceComment,
  selfqaMarker,
  parseSelfqaMarker,
  toFailureEvent,
  summarize,
} from "../../src/selfqa/render.js";
import type { RawCheckResult } from "../../src/selfqa/types.js";

/**
 * Self-QA loop (#171) — the **pure core** (catalog → classify → fingerprint → render). No IO, no clock,
 * no randomness: a given failed check always yields the same finding and the same dedup signature, which
 * is what makes "same bug twice = one issue" a property rather than a hope. Written test-first (ADR-0171).
 */

// ---- catalog -----------------------------------------------------------------------------------

describe("QA catalog", () => {
  it("covers every product surface the owner hand-tests", () => {
    const surfaces = new Set(QA_CATALOG.map((c) => c.surface));
    for (const s of ["auth", "channels", "composer", "automations", "approvals", "navigation", "sessions", "layout"]) {
      expect(surfaces.has(s as never)).toBe(true);
    }
  });

  it("has unique, non-empty check ids each with at least one repro step", () => {
    const ids = QA_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of QA_CATALOG) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.steps.length).toBeGreaterThan(0);
      expect(c.suites.length).toBeGreaterThan(0);
    }
  });

  it("smoke is a strict subset of full (every smoke check is also a full check)", () => {
    const smoke = checksForSuite("smoke");
    const full = checksForSuite("full");
    expect(smoke.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThanOrEqual(smoke.length);
    const fullIds = new Set(full.map((c) => c.id));
    for (const c of smoke) expect(fullIds.has(c.id)).toBe(true);
  });

  it("the smoke subset is exactly the critical/high checks (the fast post-deploy gate)", () => {
    for (const c of checksForSuite("smoke")) {
      expect(["critical", "high"]).toContain(c.severityOnFail);
    }
  });

  it("getCheck resolves a known id and returns undefined for an unknown one", () => {
    const first = QA_CATALOG[0]!;
    expect(getCheck(first.id)?.id).toBe(first.id);
    expect(getCheck("nope-not-a-check")).toBeUndefined();
  });
});

// ---- classify ----------------------------------------------------------------------------------

const okResult = (checkId: string): RawCheckResult => ({ checkId, ok: true });
const failResult = (checkId: string, actual?: string): RawCheckResult => ({ checkId, ok: false, actual });

describe("classifyResults", () => {
  it("turns only failed results into findings (passing checks are not bugs)", () => {
    const checks = checksForSuite("full");
    const results = checks.map((c, i) => (i === 0 ? failResult(c.id, "boom") : okResult(c.id)));
    const findings = classifyResults(results, checks);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.checkId).toBe(checks[0]!.id);
  });

  it("carries the catalog's surface, severity, title and repro steps onto the finding", () => {
    const check = QA_CATALOG.find((c) => c.surface === "layout")!;
    const [finding] = classifyResults([failResult(check.id, "scrollWidth 1200 > clientWidth 1024")], QA_CATALOG);
    expect(finding!.surface).toBe("layout");
    expect(finding!.severity).toBe(check.severityOnFail);
    expect(finding!.title).toBe(check.title);
    expect(finding!.steps).toEqual(check.steps);
    expect(finding!.actual).toContain("1200");
  });

  it("drops results for unknown check ids (never invents a finding)", () => {
    expect(classifyResults([failResult("ghost-check")], QA_CATALOG)).toHaveLength(0);
  });

  it("is deterministic — same input, same findings (including signatures)", () => {
    const check = QA_CATALOG[0]!;
    const a = classifyResults([failResult(check.id, "x")], QA_CATALOG);
    const b = classifyResults([failResult(check.id, "x")], QA_CATALOG);
    expect(a).toEqual(b);
  });
});

// ---- fingerprint -------------------------------------------------------------------------------

describe("fingerprintFinding", () => {
  it("is a stable 16-hex signature keyed on the check identity", () => {
    const sig = fingerprintFinding({ surface: "composer", checkId: "composer-send-button" });
    expect(sig).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintFinding({ surface: "composer", checkId: "composer-send-button" })).toBe(sig);
  });

  it("does NOT change when the volatile failure detail changes (same bug → one issue)", () => {
    const base = { surface: "layout" as const, checkId: "layout-no-overflow" };
    const a = fingerprintFinding({ ...base, actual: "scrollWidth 1200 at 2026-06-12T03:00:00Z run a1b2c3" });
    const b = fingerprintFinding({ ...base, actual: "scrollWidth 1320 at 2026-06-13T09:11:42Z run f9e8d7" });
    expect(a).toBe(b);
  });

  it("differs across distinct checks (two bugs → two issues)", () => {
    const a = fingerprintFinding({ surface: "composer", checkId: "composer-send-button" });
    const b = fingerprintFinding({ surface: "approvals", checkId: "approvals-approve-button" });
    expect(a).not.toBe(b);
  });
});

describe("normalizeActual", () => {
  it("scrubs volatile tokens (uuids, timestamps, hex, numbers, paths) to stable placeholders", () => {
    const out = normalizeActual(
      "session 1b4e28ba-2fa1-11d2-883f-0016d3cca427 failed at 2026-06-12T03:00:00Z, " +
        "screenshot /tmp/selfqa/run-91827/shot-44.png status 500",
    );
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(out).not.toMatch(/2026-06-12t03/i);
    expect(out).not.toContain("91827");
    expect(out).toContain("<uuid>");
    expect(out).toContain("<n>");
  });
});

// ---- render ------------------------------------------------------------------------------------

const finding = () =>
  classifyResults(
    [failResult("layout-no-overflow", "scrollWidth 1200 > clientWidth 1024 on /automations")],
    QA_CATALOG,
  )[0]!;

describe("render — owner-quality, deduped issues", () => {
  it("titles group by surface and read like the owner's report", () => {
    const t = renderFindingTitle(finding());
    expect(t).toContain("self-qa");
    expect(t.toLowerCase()).toContain("layout");
  });

  it("labels carry surface + severity for triage", () => {
    const labels = findingLabels(finding());
    expect(labels).toContain("selfqa");
    expect(labels).toContain("selfqa:layout");
    expect(labels).toContain("severity:high");
  });

  it("body has repro steps, expected/actual, acceptance criteria, the synthetic flag and the dedup marker", () => {
    const f = finding();
    const body = renderFindingBody(f, { target: "https://ipop.ai", workspaceSlug: "selfqa-system" });
    expect(body).toContain("## Repro");
    expect(body).toContain("## Acceptance criteria");
    expect(body.toLowerCase()).toContain("synthetic");
    expect(body).toContain("selfqa-system");
    // the machine-readable dedup marker the CI reporter parses back out
    expect(body).toContain(selfqaMarker(f.signature));
    expect(parseSelfqaMarker(body)).toBe(f.signature);
  });

  it("the marker round-trips and ignores unrelated bodies", () => {
    expect(parseSelfqaMarker("just a normal issue body")).toBeNull();
    expect(parseSelfqaMarker(`x ${selfqaMarker("deadbeefdeadbeef")} y`)).toBe("deadbeefdeadbeef");
  });

  it("recurrence comment references the count and never opens a new issue's worth of noise", () => {
    const c = renderRecurrenceComment(finding(), 4);
    expect(c).toContain("4");
    expect(c.toLowerCase()).toContain("still");
  });

  it("maps to a #117 flywheel FailureEvent with the qa_failure class and a stable message", () => {
    const f = finding();
    const ev = toFailureEvent(f, "ws-synthetic");
    expect(ev.workspaceId).toBe("ws-synthetic");
    expect(ev.failureClass).toBe("qa_failure");
    expect(ev.source).toBe("selfqa");
    // message must be stable (no volatile tokens) so the flywheel signature is stable too
    expect(toFailureEvent(f, "ws-synthetic").message).toBe(ev.message);
  });
});

// ---- summarize ---------------------------------------------------------------------------------

describe("summarize", () => {
  it("counts totals, failures and criticals for the run row", () => {
    const checks = checksForSuite("full");
    const crit = checks.find((c) => c.severityOnFail === "critical")!;
    const results = checks.map((c) => (c.id === crit.id ? failResult(c.id) : okResult(c.id)));
    const findings = classifyResults(results, checks);
    const summary = summarize("full", "https://ipop.ai", results, findings);
    expect(summary.checksTotal).toBe(results.length);
    expect(summary.checksFailed).toBe(1);
    expect(summary.criticalCount).toBe(1);
    expect(summary.suite).toBe("full");
  });
});
