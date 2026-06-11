import { describe, it, expect } from "vitest";
import {
  evaluateResponse,
  decideAlertAction,
  markerFor,
  parseMarker,
  alertIssueTitle,
  alertIssueBody,
  recoveryComment,
  parseTargets,
  UPTIME_LABEL,
  type ProbeTarget,
  type ProbeResult,
} from "../../src/uptime/check.js";

const API: ProbeTarget = {
  id: "api",
  name: "api.ipop.ai",
  url: "https://api.ipop.ai/readyz",
  expectStatus: [200],
  expectBody: "ready",
};
const WEB: ProbeTarget = { id: "web", name: "ipop.ai", url: "https://ipop.ai/", expectStatus: [200] };

const up = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  status: 200,
  bodySnippet: '{"status":"ready"}',
  ...over,
});

describe("evaluateResponse — the health verdict", () => {
  it("is healthy when status is expected AND the body marker is present", () => {
    expect(evaluateResponse(up(), API)).toEqual({ ok: true, detail: expect.stringMatching(/200/) });
  });

  it("is down when the status is not in the expected set", () => {
    const v = evaluateResponse(up({ status: 503, bodySnippet: "not_ready" }), API);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/503/);
  });

  it("is down when status is OK but the expected body marker is missing", () => {
    const v = evaluateResponse(up({ bodySnippet: '{"status":"degraded"}' }), API);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/ready/);
  });

  it("is down on a network error / timeout (status null) and surfaces the error", () => {
    const v = evaluateResponse({ status: null, bodySnippet: "", error: "connect ETIMEDOUT" }, API);
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/ETIMEDOUT|timeout|error/i);
  });

  it("checks status only when the target declares no body marker", () => {
    expect(evaluateResponse({ status: 200, bodySnippet: "<html>…" }, WEB).ok).toBe(true);
    expect(evaluateResponse({ status: 500, bodySnippet: "oops" }, WEB).ok).toBe(false);
  });
});

describe("markerFor / parseMarker — the dedupe key", () => {
  it("round-trips a target id through the hidden body marker", () => {
    expect(parseMarker(`some body\n${markerFor("api")}\n`)).toBe("api");
  });
  it("returns null when no marker is present", () => {
    expect(parseMarker("an unrelated issue body")).toBeNull();
  });
});

describe("decideAlertAction — the open/recover/noop dedupe brain", () => {
  const downVerdict = { ok: false, detail: "HTTP 503" };
  const upVerdict = { ok: true, detail: "HTTP 200" };

  it("opens ONE issue when down and nothing is open yet", () => {
    const a = decideAlertAction(API, downVerdict, up({ status: 503 }), null);
    expect(a.action).toBe("open");
    if (a.action === "open") {
      expect(a.title).toContain("api.ipop.ai");
      expect(a.labels).toContain(UPTIME_LABEL);
      expect(parseMarker(a.body)).toBe("api"); // the dedupe marker is embedded
    }
  });

  it("does NOT open a second issue when down and one is already open (no 5-min spam)", () => {
    const a = decideAlertAction(API, downVerdict, up({ status: 503 }), { number: 7, marker: "api" });
    expect(a.action).toBe("noop");
  });

  it("recovers (comments + closes) when back up and an issue is open", () => {
    const a = decideAlertAction(API, upVerdict, up(), { number: 7, marker: "api" });
    expect(a.action).toBe("recover");
    if (a.action === "recover") {
      expect(a.issueNumber).toBe(7);
      expect(a.comment).toMatch(/recover|back up|resolved/i);
    }
  });

  it("does nothing when up and no issue is open (the steady state)", () => {
    expect(decideAlertAction(API, upVerdict, up(), null).action).toBe("noop");
  });
});

describe("issue rendering", () => {
  it("titles name the target and read as DOWN", () => {
    expect(alertIssueTitle(API)).toMatch(/api\.ipop\.ai/);
    expect(alertIssueTitle(API).toLowerCase()).toContain("down");
  });

  it("the body carries the marker, the URL, the failing detail, and a runbook pointer", () => {
    const body = alertIssueBody(API, up({ status: 503 }), { ok: false, detail: "HTTP 503" });
    expect(parseMarker(body)).toBe("api");
    expect(body).toContain("https://api.ipop.ai/readyz");
    expect(body).toContain("HTTP 503");
    expect(body).toMatch(/runbook|operations|playbook/i);
  });

  it("the recovery comment states it is back", () => {
    expect(recoveryComment(up()).toLowerCase()).toMatch(/back|recover|resolved/);
  });
});

describe("parseTargets — config parsing", () => {
  it("defaults to api.ipop.ai (/readyz w/ marker) and ipop.ai when unset/empty", () => {
    const targets = parseTargets(undefined);
    const ids = targets.map((t) => t.id).sort();
    expect(ids).toEqual(["api", "web"]);
    const api = targets.find((t) => t.id === "api")!;
    expect(api.url).toBe("https://api.ipop.ai/readyz");
    expect(api.expectBody).toBe("ready");
    expect(targets.find((t) => t.id === "web")!.url).toBe("https://ipop.ai/");
  });

  it("accepts a JSON array override", () => {
    const targets = parseTargets(
      '[{"id":"x","name":"x.test","url":"https://x.test/health","expectStatus":[200,204]}]',
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.url).toBe("https://x.test/health");
    expect(targets[0]!.expectStatus).toEqual([200, 204]);
  });

  it("throws a clear error on malformed JSON rather than silently watching nothing", () => {
    expect(() => parseTargets("{not json")).toThrow(/UPTIME_TARGETS|json/i);
  });
});
